//! Database access for payments. Every write here is safe to repeat.

use kernel::AppResult;
use serde::Serialize;
use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

/// True when the user row is gone. Its webhook can't be applied, so it's acknowledged, not retried.
fn user_is_missing(error: &sqlx::Error) -> bool {
    matches!(error, sqlx::Error::Database(db) if db.code().as_deref() == Some("23503"))
}

/// Whether the user may use a product right now. Other crates call this before serving paid features.
pub async fn has_entitlement(db: &PgPool, user_id: Uuid, product_id: &str) -> AppResult<bool> {
    let owned: bool = sqlx::query_scalar(
        "select exists (
           select 1 from entitlements
           where user_id = $1 and product_id = $2
             and case when admin_override_status is not null then
               admin_override_status = 'active' and (admin_override_expires_at is null or admin_override_expires_at > now())
             else status in ('active', 'trialing') and (current_period_end is null or current_period_end > now()) end
         )",
    )
    .bind(user_id)
    .bind(product_id)
    .fetch_one(db)
    .await?;
    Ok(owned)
}

/// Records that an event arrived. Returns true when it was already processed, so the caller can
/// acknowledge it without doing the work again. An event that arrived but never finished is
/// processed again.
pub async fn event_already_processed(
    db: &PgPool,
    id: &str,
    kind: &str,
    livemode: bool,
) -> AppResult<bool> {
    sqlx::query(
        "insert into payment_events (id, event_type, livemode) values ($1, $2, $3)
         on conflict (id) do nothing",
    )
    .bind(id)
    .bind(kind)
    .bind(livemode)
    .execute(db)
    .await?;
    let processed: Option<Option<OffsetDateTime>> =
        sqlx::query_scalar("select processed_at from payment_events where id = $1")
            .bind(id)
            .fetch_optional(db)
            .await?;
    Ok(matches!(processed, Some(Some(_))))
}

pub async fn mark_event_processed(db: &PgPool, id: &str) -> AppResult<()> {
    sqlx::query("update payment_events set processed_at = now() where id = $1")
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

/// Records a payment once per Stripe object. Returns false when the user is gone.
pub async fn record_purchase(
    db: &PgPool,
    user_id: Uuid,
    product_id: &str,
    stripe_object_id: &str,
    amount_cents: i64,
    currency: &str,
) -> AppResult<bool> {
    let result = sqlx::query(
        "insert into purchases (user_id, product_id, stripe_object_id, amount_cents, currency)
         values ($1, $2, $3, $4, $5)
         on conflict (stripe_object_id) do nothing",
    )
    .bind(user_id)
    .bind(product_id)
    .bind(stripe_object_id)
    .bind(amount_cents)
    .bind(currency)
    .execute(db)
    .await;
    match result {
        Ok(_) => Ok(true),
        Err(error) if user_is_missing(&error) => Ok(false),
        Err(error) => Err(error.into()),
    }
}

/// What Stripe said about one entitlement, and when we read it.
pub struct Grant<'a> {
    pub user_id: Uuid,
    pub product_id: &'a str,
    pub status: &'a str,
    pub current_period_end: Option<OffsetDateTime>,
    pub customer_id: Option<&'a str>,
    pub subscription_id: Option<&'a str>,
    /// Taken before the Stripe read. A newer read always wins over an older one.
    pub synced_at: OffsetDateTime,
}

/// Returns false when the user is gone. An older read never overwrites a newer one.
pub async fn upsert_entitlement(db: &PgPool, grant: &Grant<'_>) -> AppResult<bool> {
    let result = sqlx::query(
        "insert into entitlements
           (user_id, product_id, status, current_period_end, stripe_customer_id, stripe_subscription_id, synced_at)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (user_id, product_id) do update set
           status = excluded.status,
           current_period_end = excluded.current_period_end,
           stripe_customer_id = coalesce(excluded.stripe_customer_id, entitlements.stripe_customer_id),
           stripe_subscription_id = coalesce(excluded.stripe_subscription_id, entitlements.stripe_subscription_id),
           synced_at = excluded.synced_at,
           updated_at = now()
         where entitlements.synced_at <= excluded.synced_at",
    )
    .bind(grant.user_id)
    .bind(grant.product_id)
    .bind(grant.status)
    .bind(grant.current_period_end)
    .bind(grant.customer_id)
    .bind(grant.subscription_id)
    .bind(grant.synced_at)
    .execute(db)
    .await;
    match result {
        Ok(_) => Ok(true),
        Err(error) if user_is_missing(&error) => Ok(false),
        Err(error) => Err(error.into()),
    }
}

/// The Stripe customer to open the billing portal for. A subscription's customer wins over a
/// one-off payment's customer, because only subscriptions have something to manage.
pub async fn portal_customer(db: &PgPool, user_id: Uuid) -> AppResult<Option<String>> {
    let customer: Option<String> = sqlx::query_scalar(
        "select stripe_customer_id from entitlements
         where user_id = $1 and stripe_customer_id is not null
         order by (stripe_subscription_id is not null) desc, updated_at desc
         limit 1",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?
    .flatten();
    Ok(customer)
}

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct EntitlementRow {
    pub product_id: String,
    pub status: String,
    #[serde(with = "time::serde::rfc3339::option")]
    pub current_period_end: Option<OffsetDateTime>,
    /// Computed by the database with the same rule as `has_entitlement`.
    pub active: bool,
}

pub async fn entitlements_for(db: &PgPool, user_id: Uuid) -> AppResult<Vec<EntitlementRow>> {
    let rows = sqlx::query_as::<_, EntitlementRow>(
        "select product_id,
                case when admin_override_status = 'active' and admin_override_expires_at <= now() then 'expired'
                     else coalesce(admin_override_status, status) end as status,
                case when admin_override_status is not null then admin_override_expires_at
                     else current_period_end end as current_period_end,
                case when admin_override_status is not null then
                  admin_override_status = 'active' and (admin_override_expires_at is null or admin_override_expires_at > now())
                else status in ('active', 'trialing') and (current_period_end is null or current_period_end > now()) end as active
         from entitlements where user_id = $1 order by product_id",
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;
    Ok(rows)
}

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseRow {
    pub product_id: String,
    pub amount_cents: i64,
    pub currency: String,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
}

pub async fn purchases_for(db: &PgPool, user_id: Uuid) -> AppResult<Vec<PurchaseRow>> {
    let rows = sqlx::query_as::<_, PurchaseRow>(
        "select product_id, amount_cents, currency, created_at from purchases
         where user_id = $1 order by created_at desc, id desc limit 100",
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;
    Ok(rows)
}
