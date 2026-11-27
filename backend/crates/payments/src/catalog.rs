//! The products we sell, from `config/products.json`. The browser only ever sends a product id;
//! prices and names always come from here, never from the request.

use serde::{Deserialize, Serialize};

pub const MAX_PRODUCTS: usize = 50;
/// Stripe's ceiling for one charge, in the smallest currency unit.
const MAX_PRICE_CENTS: i64 = 99_999_999;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Payment,
    Subscription,
}

impl Mode {
    /// Stripe's name for the mode, which also appears in Checkout Session objects.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Payment => "payment",
            Self::Subscription => "subscription",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Interval {
    Month,
    Year,
}

impl Interval {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Month => "month",
            Self::Year => "year",
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Product {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub price_cents: i64,
    pub currency: String,
    pub mode: Mode,
    /// Required for subscriptions unless `interval` is set; never allowed on one-off products.
    #[serde(default)]
    pub interval: Option<Interval>,
    /// An existing Stripe Price. When set, Checkout uses it instead of `priceCents`.
    #[serde(default)]
    pub stripe_price_id: Option<String>,
}

/// What the browser may see. No Stripe ids.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicProduct<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub description: &'a str,
    pub price_cents: i64,
    pub currency: &'a str,
    pub mode: Mode,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct File {
    products: Vec<Product>,
}

#[derive(Clone, Debug, Default)]
pub struct Catalog {
    products: Vec<Product>,
}

impl Catalog {
    /// Checks the whole file. One bad product rejects the file, so a typo can't sell the wrong thing.
    pub fn parse(json: &str) -> Result<Self, String> {
        let file: File = serde_json::from_str(json)
            .map_err(|error| format!("products.json is invalid: {error}"))?;
        if file.products.len() > MAX_PRODUCTS {
            return Err(format!(
                "products.json can list at most {MAX_PRODUCTS} products"
            ));
        }
        let mut seen = std::collections::HashSet::new();
        for product in &file.products {
            validate(product)?;
            if !seen.insert(product.id.as_str()) {
                return Err(format!("product id {:?} appears twice", product.id));
            }
        }
        Ok(Self {
            products: file.products,
        })
    }

    /// A missing file means no products. A broken one is logged and also means no products.
    pub fn load(path: &str) -> Self {
        match std::fs::read_to_string(path) {
            Ok(text) => match Self::parse(&text) {
                Ok(catalog) => catalog,
                Err(reason) => {
                    tracing::error!(path, reason = %reason, "products file refused; no products are for sale");
                    Self::default()
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                tracing::warn!(path, "no products file; no products are for sale");
                Self::default()
            }
            Err(error) => {
                tracing::error!(path, error = %error, "products file unreadable; no products are for sale");
                Self::default()
            }
        }
    }

    pub fn get(&self, id: &str) -> Option<&Product> {
        self.products.iter().find(|product| product.id == id)
    }

    pub fn public(&self) -> Vec<PublicProduct<'_>> {
        self.products
            .iter()
            .map(|product| PublicProduct {
                id: &product.id,
                name: &product.name,
                description: &product.description,
                price_cents: product.price_cents,
                currency: &product.currency,
                mode: product.mode,
            })
            .collect()
    }
}

fn validate(product: &Product) -> Result<(), String> {
    let id = &product.id;
    let id_ok = (2..=64).contains(&id.len())
        && id.as_bytes()[0].is_ascii_lowercase()
        && id.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-' || byte == b'_'
        });
    if !id_ok {
        return Err(format!(
            "product id {id:?} must be 2 to 64 lowercase letters, digits, - or _"
        ));
    }
    let name = product.name.trim();
    if name.is_empty() || name.chars().count() > 120 {
        return Err(format!(
            "product {id:?} needs a name of 1 to 120 characters"
        ));
    }
    if product.description.chars().count() > 500 {
        return Err(format!(
            "product {id:?} has a description over 500 characters"
        ));
    }
    let currency = &product.currency;
    if currency.len() != 3 || !currency.bytes().all(|byte| byte.is_ascii_lowercase()) {
        return Err(format!(
            "product {id:?} needs a three-letter lowercase currency such as usd"
        ));
    }
    if !(1..=MAX_PRICE_CENTS).contains(&product.price_cents) {
        return Err(format!(
            "product {id:?} needs a price between 1 and {MAX_PRICE_CENTS} cents"
        ));
    }
    if let Some(price) = &product.stripe_price_id {
        let price_ok = price.starts_with("price_")
            && price.len() <= 255
            && price
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_');
        if !price_ok {
            return Err(format!(
                "product {id:?} has a stripePriceId that doesn't look like a Stripe price"
            ));
        }
    }
    match product.mode {
        Mode::Payment if product.interval.is_some() => Err(format!(
            "product {id:?} is a one-off payment, so it can't have an interval"
        )),
        Mode::Subscription if product.stripe_price_id.is_none() && product.interval.is_none() => {
            Err(format!(
                "subscription {id:?} needs a stripePriceId or an interval"
            ))
        }
        _ => Ok(()),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn product(extra: &str) -> String {
        format!(
            r#"{{"products":[{{"id":"pro-pass","name":"Pro pass","priceCents":4900,"currency":"usd","mode":"payment"{extra}}}]}}"#
        )
    }

    #[test]
    fn a_valid_file_loads() {
        let catalog = Catalog::parse(&product("")).unwrap();
        assert_eq!(catalog.get("pro-pass").unwrap().price_cents, 4900);
        assert!(catalog.get("missing").is_none());
    }

    #[test]
    fn public_view_hides_stripe_ids() {
        let catalog = Catalog::parse(&product(r#","stripePriceId":"price_123""#)).unwrap();
        let json = serde_json::to_string(&catalog.public()).unwrap();
        assert!(!json.contains("price_123"));
        assert!(json.contains("\"priceCents\":4900"));
    }

    #[test]
    fn unknown_fields_are_refused() {
        assert!(Catalog::parse(&product(r#","price":1"#)).is_err());
    }

    #[test]
    fn bad_values_are_refused() {
        assert!(Catalog::parse(&product("").replace("4900", "0")).is_err());
        assert!(Catalog::parse(&product("").replace("usd", "US")).is_err());
        assert!(Catalog::parse(&product("").replace("pro-pass", "Pro Pass")).is_err());
        assert!(Catalog::parse(&product(r#","interval":"month""#)).is_err());
        assert!(Catalog::parse(&product("").replace("payment", "subscription")).is_err());
        assert!(Catalog::parse(&product(r#","stripePriceId":"prod_1""#)).is_err());
    }

    #[test]
    fn subscriptions_need_a_price_or_an_interval() {
        let base = r#"{"products":[{"id":"pro-plan","name":"Pro","priceCents":900,"currency":"usd","mode":"subscription"%EXTRA%}]}"#;
        assert!(Catalog::parse(&base.replace("%EXTRA%", "")).is_err());
        assert!(Catalog::parse(&base.replace("%EXTRA%", r#","interval":"month""#)).is_ok());
        assert!(Catalog::parse(&base.replace("%EXTRA%", r#","stripePriceId":"price_1""#)).is_ok());
    }

    #[test]
    fn duplicate_ids_are_refused() {
        let text = r#"{"products":[
            {"id":"a-1","name":"A","priceCents":1,"currency":"usd","mode":"payment"},
            {"id":"a-1","name":"B","priceCents":1,"currency":"usd","mode":"payment"}]}"#;
        assert!(Catalog::parse(text).is_err());
    }

    #[test]
    fn a_missing_file_is_an_empty_catalog() {
        assert!(
            Catalog::load("definitely/not/here.json")
                .get("anything")
                .is_none()
        );
    }
}
