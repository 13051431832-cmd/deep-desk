fn main() {
    println!("cargo::rustc-check-cfg=cfg(app_store)");
    if std::env::var("APP_STORE_BUILD").map_or(false, |v| v == "1") {
        println!("cargo:rustc-cfg=app_store");
    }
    // Link StoreKit framework so objc_getClass("SKPaymentQueue") works.
    // Required on macOS 26+ where StoreKit classes are not auto-loaded
    // into the ObjC runtime without explicit framework linkage.
    #[cfg(target_os = "macos")]
    println!("cargo:rustc-link-lib=framework=StoreKit");
    tauri_build::build()
}
