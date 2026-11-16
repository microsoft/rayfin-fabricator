//! Where this build of Fabricator is published and where it sends people:
//! its GitHub repository (releases, issues, source) and its documentation site.
//! The values come from `src/shared/distribution.json` through `build.rs`, so a
//! fork or an official build changes them in one place.

/// Fabricator's GitHub repository, `owner/name`.
pub const REPOSITORY: &str = env!("FABRICATOR_REPOSITORY");
/// The repository's page on GitHub.
pub const REPOSITORY_URL: &str = concat!("https://github.com/", env!("FABRICATOR_REPOSITORY"));
/// Where Fabricator's releases, and the notes for each, are published.
pub const RELEASES_URL: &str = concat!("https://github.com/", env!("FABRICATOR_REPOSITORY"), "/releases");
/// [`RELEASES_URL`]'s path on `github.com`.
pub const RELEASES_PATH: &str = concat!("/", env!("FABRICATOR_REPOSITORY"), "/releases");

/// The documentation site, without a trailing slash: `https://<host><path>`.
/// Use [`docs!`](crate::docs) for a page's address as a `&'static str`.
pub const DOCS_BASE: &str = env!("FABRICATOR_DOCS_BASE");
/// The documentation site's host, lowercase.
pub const DOCS_HOST: &str = env!("FABRICATOR_DOCS_HOST");
/// The documentation site's path on [`DOCS_HOST`], such as `/rayfin-fabricator`;
/// empty when the site is the host's root. A host such as `github.io` serves many
/// unrelated projects, so a link there must be inside this one.
pub const DOCS_PATH: &str = env!("FABRICATOR_DOCS_PATH");

/// The address of a documentation page as a `&'static str`:
/// `docs!("/docs/troubleshooting")`.
#[macro_export]
macro_rules! docs {
  ($path:literal) => {
    concat!(env!("FABRICATOR_DOCS_BASE"), $path)
  };
}

/// Whether `path`, on [`DOCS_HOST`], is inside the documentation site.
pub fn in_docs(path: &str) -> bool {
  path == DOCS_PATH || path.strip_prefix(DOCS_PATH).is_some_and(|rest| rest.starts_with('/'))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn values_match_distribution_json() {
    let config: serde_json::Value =
      serde_json::from_str(include_str!("../../src/shared/distribution.json")).unwrap();
    assert_eq!(REPOSITORY, config["repository"]);
    assert_eq!(DOCS_BASE, config["docsBase"]);
    assert_eq!(format!("https://{DOCS_HOST}{DOCS_PATH}"), DOCS_BASE.to_ascii_lowercase());
    assert_eq!(RELEASES_URL, format!("{REPOSITORY_URL}/releases"));
    assert_eq!(docs!("/docs"), format!("{DOCS_BASE}/docs"));
  }

  #[test]
  fn in_docs_stays_inside_the_site() {
    assert!(in_docs(DOCS_PATH));
    assert!(in_docs(&format!("{DOCS_PATH}/docs/ship/deploy")));
    if !DOCS_PATH.is_empty() {
      assert!(!in_docs("/some-other-project/docs"));
      assert!(!in_docs(&format!("{DOCS_PATH}-evil/docs")));
    }
  }
}
