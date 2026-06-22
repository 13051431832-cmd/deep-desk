//! Minimal StoreKit bridge for macOS In-App Purchase.
//! Uses the `objc` crate to call Apple's StoreKit framework directly.
//!
//! Product ID "001" = non-consumable Pro IAP configured in App Store Connect.
//!
//! Note: purchase/restore flow is inherently asynchronous. The Tauri commands
//! (`purchase_pro`, `restore_purchases`) only present the StoreKit UI; actual
//! results arrive through the transaction observer callback. The observer
//! emits a "purchase-updated" Tauri event so the frontend can react.

use objc::{class, msg_send, sel, sel_impl};
use objc::runtime::Object;
use std::ffi::CString;
use std::sync::OnceLock;
use tauri::Emitter;

const PRODUCT_ID: &str = "001";

/// Stored at setup so the transaction observer can emit Tauri events.
static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

/// Create an NSString from a Rust &str (returns retained object — caller must release).
unsafe fn nsstring(s: &str) -> *mut Object {
    let cstr = CString::new(s).unwrap();
    let ns: *mut Object = msg_send![class!(NSString), alloc];
    let ns: *mut Object = msg_send![ns, initWithUTF8String: cstr.as_ptr()];
    ns
}

// ── Transaction Observer ──────────────────────────────────────────────────

/// Called by StoreKit when transactions update state.
/// We finish purchased/failed/restored transactions so they don't pile up in the queue.
/// Purchasing (0) and deferred (4) are left alone — they're still in progress.
/// Emits a "purchase-updated" Tauri event so the frontend can react.
extern "C" fn payment_queue_updated_transactions(
    _self: *mut Object,
    _cmd: objc::runtime::Sel,
    _queue: *mut Object,
    transactions: *mut Object,
) {
    unsafe {
        let count: usize = msg_send![transactions, count];
        for i in 0..count {
            let transaction: *mut Object = msg_send![transactions, objectAtIndex: i];
            let state: isize = msg_send![transaction, transactionState];
            // 0=purchasing, 1=purchased, 2=failed, 3=restored, 4=deferred
            if state == 1 || state == 2 || state == 3 {
                let queue: *mut Object = msg_send![class!(SKPaymentQueue), defaultQueue];
                let _: () = msg_send![queue, finishTransaction: transaction];
                // Notify frontend so it can re-check Pro status
                if let Some(app) = APP_HANDLE.get() {
                    let event = match state {
                        1 => "purchased",
                        2 => "failed",
                        3 => "restored",
                        _ => "unknown",
                    };
                    let _ = app.emit("purchase-updated", event);
                }
            }
        }
    }
}

/// Register a transaction observer with StoreKit.
/// Must be called once at app startup, before any purchase/restore calls.
/// Without an observer, transactions are never `finishTransaction`-ed and
/// can be redelivered indefinitely on each launch.
pub fn setup_transaction_observer(app: &tauri::AppHandle) {
    // Store handle so the C callback can emit Tauri events
    let _ = APP_HANDLE.set(app.clone());

    unsafe {
        use objc::runtime::{
            class_addMethod, class_addProtocol, objc_allocateClassPair, objc_getProtocol,
            objc_registerClassPair,
        };

        let cls_name = CString::new("DeepDeskTransactionObserver").unwrap();
        let cls = objc_allocateClassPair(class!(NSObject), cls_name.as_ptr(), 0);
        if cls.is_null() {
            eprintln!("[StoreKit] Failed to allocate observer class");
            return;
        }

        // Conform to SKPaymentTransactionObserver protocol
        let proto_name = CString::new("SKPaymentTransactionObserver").unwrap();
        let proto = objc_getProtocol(proto_name.as_ptr());
        if !proto.is_null() {
            class_addProtocol(cls, proto);
        }

        // Add paymentQueue:updatedTransactions: method
        // ObjC type encoding v@:@@ → void(id, SEL, id, id)
        let types = CString::new("v@:@@").unwrap();
        let imp: unsafe extern "C" fn() =
            std::mem::transmute(payment_queue_updated_transactions as *const ());
        class_addMethod(
            cls,
            sel!(paymentQueue:updatedTransactions:),
            imp,
            types.as_ptr(),
        );

        objc_registerClassPair(cls);

        let observer: *mut Object = msg_send![cls, new];
        // StoreKit retains the observer — no need to hold a Rust-side reference.
        let queue: *mut Object = msg_send![class!(SKPaymentQueue), defaultQueue];
        let _: () = msg_send![queue, addTransactionObserver: observer];
    }
}

// ── Tauri Commands ─────────────────────────────────────────────────────────

/// Present the StoreKit payment sheet for product "001".
/// The system dialog handles the entire purchase flow asynchronously.
/// Returns immediately — the actual result arrives through the transaction
/// observer and is emitted as a "purchase-updated" Tauri event.
#[tauri::command]
pub fn purchase_pro() -> Result<String, String> {
    unsafe {
        let can_pay: bool = msg_send![class!(SKPaymentQueue), canMakePayments];
        if !can_pay {
            return Err("Purchases are disabled on this device (parental controls)".into());
        }

        let product_id = nsstring(PRODUCT_ID);
        let payment: *mut Object =
            msg_send![class!(SKMutablePayment), paymentWithProductIdentifier: product_id];
        let _: () = msg_send![product_id, release]; // paymentWithProductIdentifier retains

        let queue: *mut Object = msg_send![class!(SKPaymentQueue), defaultQueue];
        let _: () = msg_send![queue, addPayment: payment];

        Ok("Payment sheet presented — awaiting user confirmation".into())
    }
}

/// Restore previously purchased IAPs.
/// Presents the system restore dialog asynchronously.
/// The result arrives through the transaction observer as "purchase-updated" events.
#[tauri::command]
pub fn restore_purchases() -> Result<String, String> {
    unsafe {
        let queue: *mut Object = msg_send![class!(SKPaymentQueue), defaultQueue];
        let _: () = msg_send![queue, restoreCompletedTransactions];
        Ok("Restore dialog presented — awaiting user confirmation".into())
    }
}
