//! Input rules for places and map searches. Every rule names the field and says what to fix.
//! Nothing here touches the database, so the rules are easy to test on their own.

use std::collections::HashMap;

use kernel::{AppError, AppResult, ErrorCode};
use reqwest::Url;
use serde_json::{Value, json};

/// Details are capped so a hostile request can't make the error response large.
const MAX_PROBLEMS: usize = 20;
/// Longest query string we accept. Real map searches are far shorter.
const MAX_QUERY_BYTES: usize = 2048;

/// Collects every problem with a request, so people see them all at once.
#[derive(Default)]
pub struct Problems(Vec<Value>);

impl Problems {
    pub fn add(&mut self, path: &str, message: &str) {
        if self.0.len() < MAX_PROBLEMS {
            self.0.push(json!({ "path": path, "message": message }));
        }
    }

    pub fn finish(self) -> AppResult<()> {
        if self.0.is_empty() {
            Ok(())
        } else {
            Err(invalid(Value::Array(self.0)))
        }
    }
}

pub fn invalid(mut details: Value) -> AppError {
    if let Some(items) = details.as_array_mut() {
        for item in items {
            if let Some(path) = item.get("path").and_then(Value::as_str) {
                let normalized = path.trim_start_matches(['/', '?']).replace('/', ".");
                item["path"] = json!(normalized);
            }
        }
    }
    AppError::new(
        ErrorCode::ValidationFailed,
        "Please check the highlighted fields.",
    )
    .with_details(details)
}

fn bad_param(name: &str, message: &str) -> AppError {
    invalid(json!([{ "path": name, "message": message }]))
}

/// Trims a text field and checks its length. Single-line fields refuse every control character.
/// Multi-line fields keep line breaks, which people use in descriptions.
pub fn text(problems: &mut Problems, path: &str, raw: &str, max: usize, multiline: bool) -> String {
    let value = if multiline {
        raw.replace("\r\n", "\n").trim().to_owned()
    } else {
        raw.trim().to_owned()
    };
    if value.chars().count() > max {
        problems.add(path, &format!("Use at most {max} characters."));
    }
    if value
        .chars()
        .any(|character| character.is_control() && !(multiline && character == '\n'))
    {
        problems.add(path, "Remove the hidden characters.");
    }
    value
}

pub fn latitude(problems: &mut Problems, path: &str, value: f64) {
    if !value.is_finite() || value.abs() > 90.0 {
        problems.add(path, "Latitude must be between -90 and 90.");
    }
}

pub fn longitude(problems: &mut Problems, path: &str, value: f64) {
    if !value.is_finite() || value.abs() > 180.0 {
        problems.add(path, "Longitude must be between -180 and 180.");
    }
}

pub fn visibility(problems: &mut Problems, raw: &str) -> String {
    match raw {
        "private" | "public" => raw.to_owned(),
        _ => {
            problems.add("/visibility", "Choose private or public.");
            "private".to_owned()
        }
    }
}

/// Categories are short lowercase labels, so filters match exactly.
pub fn category(problems: &mut Problems, raw: &str) -> String {
    text(problems, "/category", raw, 40, false).to_lowercase()
}

/// A longitude range. When `wrap` is set the range crosses the antimeridian: a value is inside when
/// it is at least `from` or at most `to`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LngRange {
    pub from: f64,
    pub to: f64,
    pub wrap: bool,
}

impl LngRange {
    pub fn all() -> Self {
        Self {
            from: -180.0,
            to: 180.0,
            wrap: false,
        }
    }
}

/// A map viewport as the client sends it: `minLng,minLat,maxLng,maxLat`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BBox {
    pub min_lat: f64,
    pub max_lat: f64,
    pub lng: LngRange,
}

/// Parses a viewport. A west edge east of the east edge means the view crosses the antimeridian
/// (180° longitude), which map libraries send when the world is wrapped. Latitudes must be ordered,
/// and every value must be a finite number in range.
pub fn bbox(raw: &str) -> AppResult<BBox> {
    let parsed: Result<Vec<f64>, _> = raw
        .split(',')
        .map(|part| part.trim().parse::<f64>())
        .collect();
    let values: [f64; 4] = match parsed {
        Ok(values) if raw.len() <= 120 => values
            .try_into()
            .map_err(|_| bad_param("bbox", "Use four numbers: minLng,minLat,maxLng,maxLat."))?,
        _ => {
            return Err(bad_param(
                "bbox",
                "Use four numbers: minLng,minLat,maxLng,maxLat.",
            ));
        }
    };
    let [min_lng, min_lat, max_lng, max_lat] = values;
    let mut problems = Problems::default();
    if [min_lng, min_lat, max_lng, max_lat]
        .iter()
        .any(|value| !value.is_finite())
    {
        problems.add("?bbox", "Every value must be a number.");
    }
    for value in [min_lng, max_lng] {
        longitude(&mut problems, "?bbox", value);
    }
    for value in [min_lat, max_lat] {
        latitude(&mut problems, "?bbox", value);
    }
    if min_lat > max_lat {
        problems.add("?bbox", "minLat must not be above maxLat.");
    }
    problems.finish()?;
    Ok(BBox {
        min_lat,
        max_lat,
        lng: LngRange {
            from: min_lng,
            to: max_lng,
            wrap: min_lng > max_lng,
        },
    })
}

/// Longitude window for a radius search. The window is a little wider than the true circle; the exact
/// distance check in SQL removes the extra rows. Near a pole, or when the circle is too big for a
/// simple window, the window covers every longitude.
pub fn circle_window(lat: f64, lng: f64, radius_km: f64) -> (f64, f64, LngRange) {
    const EARTH_RADIUS_KM: f64 = 6371.0;
    const PAD_DEGREES: f64 = 0.001;
    let angle = radius_km / EARTH_RADIUS_KM;
    let d_lat = angle.to_degrees() + PAD_DEGREES;
    let min_lat = (lat - d_lat).max(-90.0);
    let max_lat = (lat + d_lat).min(90.0);
    let cos_lat = lat.to_radians().cos();
    let ratio = angle.sin() / cos_lat;
    let touches_pole = lat + d_lat >= 90.0 || lat - d_lat <= -90.0;
    if touches_pole || !ratio.is_finite() || ratio >= 1.0 {
        return (min_lat, max_lat, LngRange::all());
    }
    let d_lng = ratio.asin().to_degrees() + PAD_DEGREES;
    if d_lng >= 180.0 {
        return (min_lat, max_lat, LngRange::all());
    }
    let low = lng - d_lng;
    let high = lng + d_lng;
    let lng = if low < -180.0 {
        LngRange {
            from: low + 360.0,
            to: high,
            wrap: true,
        }
    } else if high > 180.0 {
        LngRange {
            from: low,
            to: high - 360.0,
            wrap: true,
        }
    } else {
        LngRange {
            from: low,
            to: high,
            wrap: false,
        }
    };
    (min_lat, max_lat, lng)
}

/// Parses a decimal parameter and checks its range. Non-finite values are refused.
pub fn number_param(name: &str, raw: &str, min: f64, max: f64) -> AppResult<f64> {
    let value: f64 = raw
        .trim()
        .parse()
        .map_err(|_| bad_param(name, "Use a number."))?;
    if !value.is_finite() || value < min || value > max {
        return Err(bad_param(
            name,
            &format!("Use a number from {min} to {max}."),
        ));
    }
    Ok(value)
}

/// `limit` is optional: `default` applies when it's missing, and `max` is the hard cap.
pub fn limit(raw: Option<&str>, default: i64, max: i64) -> AppResult<i64> {
    match raw {
        None => Ok(default),
        Some(raw) => {
            let value: i64 = raw
                .trim()
                .parse()
                .map_err(|_| bad_param("limit", "Use a whole number."))?;
            if value < 1 || value > max {
                return Err(bad_param(
                    "limit",
                    &format!("Use a number from 1 to {max}."),
                ));
            }
            Ok(value)
        }
    }
}

/// Reads a query string into a map. Only the listed names are allowed, each may appear once, and
/// values are capped. Percent-decoding is done by the URL parser, so nothing is decoded twice.
pub fn query_params(raw: Option<&str>, allowed: &[&str]) -> AppResult<HashMap<String, String>> {
    if raw.is_some_and(|raw| raw.len() > MAX_QUERY_BYTES) {
        return Err(bad_param("query", "The request is too long."));
    }
    let mut url = Url::parse("http://localhost/").map_err(AppError::internal)?;
    url.set_query(raw);
    let mut out = HashMap::new();
    for (key, value) in url.query_pairs() {
        let name: &str = &key;
        if !allowed.contains(&name) {
            return Err(bad_param("query", "This search option doesn't exist."));
        }
        if out.contains_key(name) {
            return Err(bad_param(name, "Use each option only once."));
        }
        if value.chars().count() > 300 {
            return Err(bad_param(name, "This value is too long."));
        }
        out.insert(name.to_owned(), value.into_owned());
    }
    Ok(out)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    fn details_of(error: &AppError) -> String {
        error
            .details
            .as_ref()
            .map(Value::to_string)
            .unwrap_or_default()
    }

    #[test]
    fn text_trims_limits_and_rejects_hidden_characters() {
        let mut problems = Problems::default();
        assert_eq!(text(&mut problems, "/name", "  Cafe  ", 10, false), "Cafe");
        assert!(problems.finish().is_ok());

        let mut problems = Problems::default();
        text(&mut problems, "/name", &"a".repeat(121), 120, false);
        assert!(problems.finish().is_err());

        let mut problems = Problems::default();
        text(&mut problems, "/name", "bad\u{0}name", 120, false);
        assert!(problems.finish().is_err());

        let mut problems = Problems::default();
        let kept = text(
            &mut problems,
            "/description",
            "line one\r\nline two",
            100,
            true,
        );
        assert_eq!(kept, "line one\nline two");
        assert!(problems.finish().is_ok());

        let mut problems = Problems::default();
        text(&mut problems, "/description", "tab\tinside", 100, true);
        assert!(
            problems.finish().is_err(),
            "tabs are not allowed in descriptions"
        );
    }

    #[test]
    fn problems_are_capped() {
        let mut problems = Problems::default();
        for _ in 0..50 {
            problems.add("/x", "bad");
        }
        let error = problems.finish().unwrap_err();
        assert_eq!(
            error.details.unwrap().as_array().unwrap().len(),
            MAX_PROBLEMS
        );
    }

    #[test]
    fn coordinates_must_be_finite_and_in_range() {
        for (value, ok) in [
            (0.0, true),
            (90.0, true),
            (-90.0, true),
            (90.5, false),
            (f64::NAN, false),
        ] {
            let mut problems = Problems::default();
            latitude(&mut problems, "/lat", value);
            assert_eq!(problems.finish().is_ok(), ok, "lat {value}");
        }
        for (value, ok) in [
            (180.0, true),
            (-180.0, true),
            (180.1, false),
            (f64::INFINITY, false),
        ] {
            let mut problems = Problems::default();
            longitude(&mut problems, "/lng", value);
            assert_eq!(problems.finish().is_ok(), ok, "lng {value}");
        }
    }

    #[test]
    fn bbox_accepts_a_normal_view() {
        let parsed = bbox("-0.2,51.4,0.1,51.6").unwrap();
        assert_eq!(parsed.min_lat, 51.4);
        assert_eq!(parsed.max_lat, 51.6);
        assert_eq!(
            parsed.lng,
            LngRange {
                from: -0.2,
                to: 0.1,
                wrap: false
            }
        );
    }

    #[test]
    fn bbox_accepts_an_antimeridian_crossing() {
        let parsed = bbox("170,-10,-170,10").unwrap();
        assert!(parsed.lng.wrap);
        assert_eq!(parsed.lng.from, 170.0);
        assert_eq!(parsed.lng.to, -170.0);
    }

    #[test]
    fn bbox_refuses_inverted_latitudes_and_bad_numbers() {
        for raw in [
            "0,10,1,5",    // minLat above maxLat
            "0,0,1",       // too few numbers
            "0,0,1,1,1",   // too many numbers
            "0,0,1,abc",   // not a number
            "0,0,1,NaN",   // NaN parses as a float, so it needs its own check
            "0,0,1,inf",   // infinity
            "1e308,0,1,1", // huge but finite is still out of range
            "0,-91,1,1",   // latitude out of range
            "0,0,181,1",   // longitude out of range
            "",            // empty
        ] {
            assert!(bbox(raw).is_err(), "{raw} should be refused");
        }
        let error = bbox("0,10,1,5").unwrap_err();
        assert_eq!(error.code, ErrorCode::ValidationFailed);
    }

    #[test]
    fn bbox_refuses_very_long_input() {
        let raw = format!("0,0,1,1{}", ",0".repeat(80));
        assert!(bbox(&raw).is_err());
    }

    #[test]
    fn circle_window_is_all_longitudes_near_a_pole() {
        let (_, _, lng) = circle_window(89.9, 0.0, 50.0);
        assert_eq!(lng, LngRange::all());
    }

    #[test]
    fn circle_window_wraps_across_the_antimeridian() {
        let (min_lat, max_lat, lng) = circle_window(0.0, 179.9, 50.0);
        assert!(min_lat < 0.0 && max_lat > 0.0);
        assert!(lng.wrap, "a circle at 179.9 crosses 180 and must wrap");
        assert!(lng.from > 0.0 && lng.to < 0.0);

        let (_, _, lng) = circle_window(0.0, -179.9, 50.0);
        assert!(lng.wrap);
    }

    #[test]
    fn circle_window_does_not_wrap_in_the_middle_of_the_world() {
        let (_, _, lng) = circle_window(51.5, -0.1, 5.0);
        assert!(!lng.wrap);
        assert!(lng.from < -0.1 && lng.to > -0.1);
    }

    #[test]
    fn number_and_limit_params_are_bounded() {
        assert_eq!(number_param("radiusKm", "5", 0.0, 50.0).unwrap(), 5.0);
        assert!(number_param("radiusKm", "0", 0.001, 50.0).is_err());
        assert!(number_param("radiusKm", "50.1", 0.0, 50.0).is_err());
        assert!(number_param("radiusKm", "NaN", 0.0, 50.0).is_err());
        assert_eq!(limit(None, 200, 500).unwrap(), 200);
        assert_eq!(limit(Some("500"), 200, 500).unwrap(), 500);
        assert!(limit(Some("501"), 200, 500).is_err());
        assert!(limit(Some("0"), 200, 500).is_err());
        assert!(limit(Some("ten"), 200, 500).is_err());
    }

    #[test]
    fn query_params_reject_unknown_and_repeated_names() {
        let allowed = ["bbox", "q"];
        let params = query_params(Some("bbox=1%2C2&q=caf%C3%A9+bar"), &allowed).unwrap();
        assert_eq!(params["bbox"], "1,2");
        assert_eq!(params["q"], "café bar");
        assert!(query_params(Some("bbox=1&bbox=2"), &allowed).is_err());
        assert!(query_params(Some("admin=1"), &allowed).is_err());
        assert!(query_params(None, &allowed).unwrap().is_empty());
        let long = format!("q={}", "a".repeat(MAX_QUERY_BYTES));
        assert!(query_params(Some(&long), &allowed).is_err());
        let error = query_params(Some("admin=1"), &allowed).unwrap_err();
        assert!(details_of(&error).contains("query"));
    }

    #[test]
    fn visibility_and_category_rules() {
        let mut problems = Problems::default();
        assert_eq!(visibility(&mut problems, "public"), "public");
        assert!(problems.finish().is_ok());
        let mut problems = Problems::default();
        visibility(&mut problems, "everyone");
        assert!(problems.finish().is_err());
        let mut problems = Problems::default();
        assert_eq!(category(&mut problems, "  Coffee "), "coffee");
        assert!(problems.finish().is_ok());
    }
}
