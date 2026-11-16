//! Besides Tauri's build, hands the distribution settings (`src/shared/distribution.json`)
//! to the crate as `FABRICATOR_*` environment variables, read by `src/distribution.rs`, and
//! fails the build when `tauri.conf.json`'s updater copy of them has drifted.

use std::path::Path;

fn main() {
  distribution();
  tauri_build::build()
}

fn distribution() {
  const FILE: &str = "../src/shared/distribution.json";
  println!("cargo:rerun-if-changed={FILE}");
  println!("cargo:rerun-if-changed=tauri.conf.json");
  let read = |path: &str| -> serde_json::Value {
    let text = std::fs::read_to_string(Path::new(path)).unwrap_or_else(|e| panic!("can't read {path}: {e}"));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{path} isn't JSON: {e}"))
  };
  let config = read(FILE);
  let text = |pointer: &str| -> String {
    config
      .pointer(pointer)
      .and_then(|v| v.as_str())
      .filter(|v| !v.is_empty())
      .unwrap_or_else(|| panic!("{FILE} needs {pointer}"))
      .to_string()
  };

  let repository = text("/repository");
  assert!(
    repository.split('/').count() == 2 && !repository.contains(char::is_whitespace),
    "{FILE}: repository must be owner/name"
  );
  let docs_base = text("/docsBase");
  let rest = docs_base
    .strip_prefix("https://")
    .filter(|_| !docs_base.ends_with('/'))
    .unwrap_or_else(|| panic!("{FILE}: docsBase must be an https URL without a trailing slash"));
  let (docs_host, docs_path) = match rest.find('/') {
    Some(at) => (&rest[..at], &rest[at..]),
    None => (rest, ""),
  };

  let conf = read("tauri.conf.json");
  let updater = &conf["plugins"]["updater"];
  assert!(
    updater["endpoints"] == serde_json::json!([text("/updater/endpoint")])
      && updater["pubkey"].as_str() == Some(text("/updater/pubkey").as_str()),
    "tauri.conf.json's plugins.updater doesn't match {FILE}. Run `node scripts/distribution/sync.mjs`."
  );

  println!("cargo:rustc-env=FABRICATOR_REPOSITORY={repository}");
  println!("cargo:rustc-env=FABRICATOR_DOCS_BASE={docs_base}");
  println!("cargo:rustc-env=FABRICATOR_DOCS_HOST={}", docs_host.to_ascii_lowercase());
  println!("cargo:rustc-env=FABRICATOR_DOCS_PATH={docs_path}");
}
