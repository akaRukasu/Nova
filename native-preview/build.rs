use std::{env, path::PathBuf};

fn main() {
    println!("cargo:rerun-if-changed=nacre.manifest");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap())
            .join("nacre.manifest");
        println!("cargo:rustc-link-arg-bin=nacre=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg-bin=nacre=/MANIFESTINPUT:{}", manifest.display());
    }
}
