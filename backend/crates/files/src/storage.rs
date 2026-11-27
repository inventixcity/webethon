use async_trait::async_trait;
use bytes::Bytes;
use futures::stream::BoxStream;
use object_store::aws::AmazonS3Builder;
use object_store::local::LocalFileSystem;
use object_store::{
    ObjectStore, ObjectStoreExt,
    path::Path,
    signer::{Method, Signer},
};
use std::{path::PathBuf, sync::Arc};

#[async_trait]
pub trait Storage: Send + Sync {
    async fn put(&self, key: &str, bytes: Bytes) -> anyhow::Result<()>;
    async fn get(
        &self,
        key: &str,
    ) -> anyhow::Result<BoxStream<'static, Result<Bytes, object_store::Error>>>;
    async fn delete(&self, key: &str) -> anyhow::Result<()>;
    async fn presigned_get(&self, _key: &str) -> anyhow::Result<Option<String>> {
        Ok(None)
    }
}

struct Backend(Arc<dyn ObjectStore>, Option<Arc<dyn Signer>>);
#[async_trait]
impl Storage for Backend {
    async fn put(&self, key: &str, bytes: Bytes) -> anyhow::Result<()> {
        self.0.put(&Path::parse(key)?, bytes.into()).await?;
        Ok(())
    }
    async fn get(
        &self,
        key: &str,
    ) -> anyhow::Result<BoxStream<'static, Result<Bytes, object_store::Error>>> {
        Ok(self.0.get(&Path::parse(key)?).await?.into_stream())
    }
    async fn delete(&self, key: &str) -> anyhow::Result<()> {
        self.0.delete(&Path::parse(key)?).await?;
        Ok(())
    }
    async fn presigned_get(&self, key: &str) -> anyhow::Result<Option<String>> {
        match &self.1 {
            Some(signer) => Ok(Some(
                signer
                    .signed_url(
                        Method::GET,
                        &Path::parse(key)?,
                        std::time::Duration::from_secs(300),
                    )
                    .await?
                    .to_string(),
            )),
            None => Ok(None),
        }
    }
}

/// Why a stored object could not be opened.
#[derive(Debug)]
pub enum ReadError {
    /// The database row exists but the bytes are gone (lost volume, changed STORAGE_DIR).
    Missing,
    /// Any other storage failure. The cause is for server logs only, never for clients.
    Failed(anyhow::Error),
}

pub type ObjectStream = BoxStream<'static, Result<Bytes, object_store::Error>>;

/// Opens a stored object, telling "gone" apart from real I/O failures.
/// Backends wrap object_store errors in anyhow, so the typed error is looked up underneath.
pub async fn open(storage: &dyn Storage, key: &str) -> Result<ObjectStream, ReadError> {
    storage
        .get(key)
        .await
        .map_err(|error| match error.downcast_ref::<object_store::Error>() {
            Some(object_store::Error::NotFound { .. }) => ReadError::Missing,
            _ => ReadError::Failed(error),
        })
}

pub fn storage_from_env() -> anyhow::Result<Arc<dyn Storage>> {
    let production = std::env::var("APP_ENV").is_ok_and(|v| v.eq_ignore_ascii_case("production"));
    let backend = std::env::var("STORAGE_BACKEND").unwrap_or_default();
    let (store, signer): (Arc<dyn ObjectStore>, Option<Arc<dyn Signer>>) = match backend.as_str() {
        "" | "local" if !production => {
            let dir =
                PathBuf::from(std::env::var("STORAGE_DIR").unwrap_or_else(|_| "./storage".into()));
            std::fs::create_dir_all(&dir)?;
            (
                Arc::new(LocalFileSystem::new_with_prefix(dir.canonicalize()?)?),
                None,
            )
        }
        "s3" => {
            let mut builder = AmazonS3Builder::new()
                .with_region(std::env::var("S3_REGION")?)
                .with_bucket_name(std::env::var("S3_BUCKET")?)
                .with_access_key_id(std::env::var("S3_ACCESS_KEY_ID")?)
                .with_secret_access_key(std::env::var("S3_SECRET_ACCESS_KEY")?);
            if let Ok(endpoint) = std::env::var("S3_ENDPOINT") {
                builder = builder
                    .with_allow_http(endpoint.starts_with("http://"))
                    .with_endpoint(endpoint);
            }
            let path_style = std::env::var("S3_FORCE_PATH_STYLE")
                .unwrap_or_else(|_| "false".into())
                .parse::<bool>()?;
            builder = builder.with_virtual_hosted_style_request(!path_style);
            let s3 = Arc::new(builder.build()?);
            (s3.clone(), Some(s3))
        }
        // Deployments that serve no uploads (file routes unmounted) keep an empty in-memory store.
        "disabled" => (Arc::new(object_store::memory::InMemory::new()), None),
        "" | "local" => anyhow::bail!("local storage is disabled in production"),
        _ => anyhow::bail!("unknown STORAGE_BACKEND"),
    };
    Ok(Arc::new(Backend(store, signer)))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
pub(crate) fn test_local(dir: &std::path::Path) -> Arc<dyn Storage> {
    Arc::new(Backend(
        Arc::new(LocalFileSystem::new_with_prefix(dir).unwrap()),
        None,
    ))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    struct Broken;
    #[async_trait]
    impl Storage for Broken {
        async fn put(&self, _key: &str, _bytes: Bytes) -> anyhow::Result<()> {
            anyhow::bail!("unused")
        }
        async fn get(&self, _key: &str) -> anyhow::Result<ObjectStream> {
            anyhow::bail!("connection reset by peer")
        }
        async fn delete(&self, _key: &str) -> anyhow::Result<()> {
            anyhow::bail!("unused")
        }
    }

    #[tokio::test]
    async fn open_reports_an_absent_object_as_missing() {
        let dir = std::env::temp_dir().join(format!("files-storage-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let storage = test_local(&dir);
        assert!(matches!(
            open(storage.as_ref(), "u/nobody/none.png").await,
            Err(ReadError::Missing)
        ));
        // A directory sitting where the object should be is not a readable object either.
        std::fs::create_dir_all(dir.join("u/dir.png")).unwrap();
        assert!(matches!(
            open(storage.as_ref(), "u/dir.png").await,
            Err(ReadError::Missing)
        ));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn open_keeps_other_failures_as_failed() {
        assert!(matches!(
            open(&Broken, "u/any.png").await,
            Err(ReadError::Failed(_))
        ));
    }
}
