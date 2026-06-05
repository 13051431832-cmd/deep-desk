fn main() {
    println!("cargo::rustc-check-cfg=cfg(app_store)");
    if std::env::var("APP_STORE_BUILD").map_or(false, |v| v == "1") {
        println!("cargo:rustc-cfg=app_store");
    }
    tauri_build::build()
}
