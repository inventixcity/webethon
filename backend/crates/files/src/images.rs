use image::{ImageFormat, ImageReader, Limits, codecs::jpeg::JpegEncoder};
use std::io::Cursor;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Png,
    Jpeg,
    Webp,
    Gif,
    Pdf,
}

pub fn detect(data: &[u8]) -> Option<Kind> {
    if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(Kind::Png)
    } else if data.starts_with(b"\xff\xd8\xff") {
        Some(Kind::Jpeg)
    } else if data.len() >= 12 && &data[..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        Some(Kind::Webp)
    } else if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
        Some(Kind::Gif)
    } else if data.starts_with(b"%PDF-") {
        Some(Kind::Pdf)
    } else {
        None
    }
}

pub struct Processed {
    pub bytes: Vec<u8>,
    pub content_type: &'static str,
    pub ext: &'static str,
    pub width: Option<i32>,
    pub height: Option<i32>,
}

pub fn process(data: Vec<u8>, kind: Kind) -> anyhow::Result<Processed> {
    if kind == Kind::Pdf {
        anyhow::ensure!(
            data[data.len().saturating_sub(1024)..]
                .windows(5)
                .any(|w| w == b"%%EOF"),
            "invalid PDF"
        );
        return Ok(Processed {
            bytes: data,
            content_type: "application/pdf",
            ext: "pdf",
            width: None,
            height: None,
        });
    }
    let format = match kind {
        Kind::Png => ImageFormat::Png,
        Kind::Jpeg => ImageFormat::Jpeg,
        Kind::Webp => ImageFormat::WebP,
        Kind::Gif => ImageFormat::Gif,
        Kind::Pdf => unreachable!(),
    };
    let mut reader = ImageReader::with_format(Cursor::new(data), format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(8000);
    limits.max_image_height = Some(8000);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    let image = reader.decode()?;
    let width = i32::try_from(image.width())?;
    let height = i32::try_from(image.height())?;
    let mut output = Cursor::new(Vec::new());
    let (content_type, ext) = if kind == Kind::Jpeg {
        JpegEncoder::new_with_quality(&mut output, 85).encode_image(&image)?;
        ("image/jpeg", "jpg")
    } else {
        image.write_to(&mut output, ImageFormat::Png)?;
        ("image/png", "png")
    };
    Ok(Processed {
        bytes: output.into_inner(),
        content_type,
        ext,
        width: Some(width),
        height: Some(height),
    })
}

pub fn sanitize_filename(name: &str) -> Option<String> {
    let name = name.rsplit(['/', '\\']).next().unwrap_or_default();
    let clean: String = name.chars().filter(|c| !c.is_control() && !matches!(*c, '\u{061c}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')).take(255).collect();
    let clean = clean.trim_matches(|c: char| c.is_whitespace() || c == '.');
    if clean.is_empty() {
        None
    } else {
        Some(clean.to_owned())
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    #[test]
    fn signatures() {
        for (bytes, kind) in [
            (&b"\x89PNG\r\n\x1a\n"[..], Kind::Png),
            (b"\xff\xd8\xff", Kind::Jpeg),
            (b"RIFF1234WEBP", Kind::Webp),
            (b"GIF89a", Kind::Gif),
            (b"%PDF-", Kind::Pdf),
        ] {
            assert_eq!(detect(bytes), Some(kind));
        }
        for bytes in [&b"<html>"[..], b"<svg>", b"MZblah", b"PK\x03\x04"] {
            assert_eq!(detect(bytes), None);
        }
    }
    #[test]
    fn filenames() {
        assert_eq!(
            sanitize_filename("../../x\u{202e}\n.jpg").as_deref(),
            Some("x.jpg")
        );
        assert_eq!(
            sanitize_filename(&"a".repeat(300)).unwrap().chars().count(),
            255
        );
        assert_eq!(sanitize_filename("../.."), None);
    }
    #[test]
    fn strips_exif() {
        let img = image::DynamicImage::new_rgb8(1, 1);
        let mut jpeg = Vec::new();
        JpegEncoder::new(&mut jpeg).encode_image(&img).unwrap();
        jpeg.splice(2..2, b"\xff\xe1\x00\x0aExif\0\0xx".iter().copied());
        let result = process(jpeg, Kind::Jpeg).unwrap();
        assert!(!result.bytes.windows(4).any(|s| s == b"Exif"));
    }
}
