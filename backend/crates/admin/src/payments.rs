use crate::{AdminViewer, JsonBody, audit, security, shared};
use ::payments::Catalog;
use axum::{Extension, Json, extract::State, http::StatusCode};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use kernel::{
    AppError, AppResult, AppState, Viewer,
    extract::Query,
    request::RequestMeta,
    security::{enforce_rate_limit, limits},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct List {
    q: Option<String>,
    user_id: Option<String>,
    product_id: Option<String>,
    status: Option<String>,
    limit: Option<i64>,
    cursor: Option<String>,
}

fn cursor(
    raw: Option<&str>,
    entitlement: bool,
) -> AppResult<Option<(OffsetDateTime, Uuid, String)>> {
    let Some(raw) = raw.filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    if raw.len() > 256 {
        return Err(shared::invalid("cursor"));
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(raw)
        .map_err(|_| shared::invalid("cursor"))?;
    let text = std::str::from_utf8(&bytes).map_err(|_| shared::invalid("cursor"))?;
    let mut parts = text.split('|');
    let at = parts
        .next()
        .and_then(|s| OffsetDateTime::parse(s, &Rfc3339).ok())
        .ok_or_else(|| shared::invalid("cursor"))?;
    let id = parts
        .next()
        .and_then(|s| Uuid::parse_str(s).ok())
        .ok_or_else(|| shared::invalid("cursor"))?;
    let product = parts.next().ok_or_else(|| shared::invalid("cursor"))?;
    if parts.next().is_some()
        || product.len() > 64
        || (entitlement && product.is_empty())
        || (!entitlement && !product.is_empty())
    {
        return Err(shared::invalid("cursor"));
    }
    Ok(Some((at, id, product.to_owned())))
}
fn encode(at: OffsetDateTime, id: Uuid, product: &str) -> AppResult<String> {
    Ok(URL_SAFE_NO_PAD.encode(format!("{}|{id}|{product}", shared::rfc3339(at)?)))
}
async fn page(s: &AppState, q: List, entitlement: bool) -> AppResult<Json<Value>> {
    let limit = shared::bounded_limit(q.limit)?;
    let search =
        shared::text(q.q.as_deref(), "q", shared::MAX_SEARCH_CHARS)?.map(shared::like_pattern);
    let user = shared::uuid_filter(q.user_id.as_deref(), "userId")?;
    let product = shared::text(q.product_id.as_deref(), "productId", 64)?;
    let status = shared::text(q.status.as_deref(), "status", 32)?;
    if status.is_some_and(|v| {
        !entitlement
            || ![
                "active",
                "revoked",
                "expired",
                "past_due",
                "canceled",
                "unpaid",
                "incomplete",
                "incomplete_expired",
                "trialing",
                "paused",
            ]
            .contains(&v)
    }) {
        return Err(shared::invalid("status"));
    }
    let cur = cursor(q.cursor.as_deref(), entitlement)?;
    let (at, id, key) = cur
        .map(|(a, b, c)| (Some(a), Some(b), Some(c)))
        .unwrap_or((None, None, None));
    let rows: Vec<(OffsetDateTime, Uuid, String, Value)> = if entitlement {
        sqlx::query_as(r#"select e.created_at,e.user_id,e.product_id,jsonb_build_object('userId',e.user_id,'email',u.email::text,'productId',e.product_id,'status',case when e.admin_override_status='active' and e.admin_override_expires_at <= now() then 'expired' else coalesce(e.admin_override_status,e.status) end,'currentPeriodEnd',case when e.admin_override_status is not null then e.admin_override_expires_at else e.current_period_end end,'adminOverrideStatus',e.admin_override_status,'adminOverrideExpiresAt',e.admin_override_expires_at,'createdAt',e.created_at,'updatedAt',e.updated_at) from entitlements e join users u on u.id=e.user_id where ($1::text is null or u.email::text ilike $1 escape '\' or e.product_id ilike $1 escape '\' or e.user_id::text ilike $1 escape '\') and ($2::uuid is null or e.user_id=$2) and ($3::text is null or e.product_id=$3) and ($4::text is null or (case when e.admin_override_status='active' and e.admin_override_expires_at <= now() then 'expired' else coalesce(e.admin_override_status,e.status) end)=$4) and ($5::timestamptz is null or (e.created_at,e.user_id,e.product_id)<($5,$6,$7)) order by e.created_at desc,e.user_id desc,e.product_id desc limit $8"#).bind(search).bind(user).bind(product).bind(status).bind(at).bind(id).bind(key).bind(limit+1).fetch_all(&s.db).await?
    } else {
        sqlx::query_as(r#"select p.created_at,p.id,''::text,jsonb_build_object('id',p.id,'userId',p.user_id,'email',u.email::text,'productId',p.product_id,'amountCents',p.amount_cents,'currency',p.currency,'createdAt',p.created_at,'stripeDashboardUrl',case when p.stripe_object_id ~ '^(cs|in|pi|ch)_[A-Za-z0-9_]+$' then 'https://dashboard.stripe.com/search?query=' || p.stripe_object_id else null end) from purchases p join users u on u.id=p.user_id where ($1::text is null or u.email::text ilike $1 escape '\' or p.product_id ilike $1 escape '\' or p.user_id::text ilike $1 escape '\') and ($2::uuid is null or p.user_id=$2) and ($3::text is null or p.product_id=$3) and ($4::timestamptz is null or (p.created_at,p.id)<($4,$5)) order by p.created_at desc,p.id desc limit $6"#).bind(search).bind(user).bind(product).bind(at).bind(id).bind(limit+1).fetch_all(&s.db).await?
    };
    let more = rows.len() > limit as usize;
    let mut rows = rows;
    rows.truncate(limit as usize);
    let next = if more {
        rows.last().map(|r| encode(r.0, r.1, &r.2)).transpose()?
    } else {
        None
    };
    Ok(Json(
        json!({"data":rows.into_iter().map(|r|r.3).collect::<Vec<_>>(),"meta":{"nextCursor":next}}),
    ))
}
pub(crate) async fn purchases(
    State(s): State<AppState>,
    AdminViewer(_): AdminViewer,
    Query(q): Query<List>,
) -> AppResult<Json<Value>> {
    page(&s, q, false).await
}
pub(crate) async fn entitlements(
    State(s): State<AppState>,
    AdminViewer(_): AdminViewer,
    Query(q): Query<List>,
) -> AppResult<Json<Value>> {
    page(&s, q, true).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Grant {
    user_id: Uuid,
    product_id: String,
    expires_at: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Revoke {
    user_id: Uuid,
    product_id: String,
}
async fn change(
    (s, catalog): (AppState, Arc<Catalog>),
    v: Viewer,
    m: RequestMeta,
    user: Uuid,
    product: String,
    expiry: Option<String>,
    grant: bool,
) -> AppResult<StatusCode> {
    enforce_rate_limit(
        &s.db,
        &format!("admin:entitlements:ip:{}", m.ip),
        limits::API_WRITE_PER_SUBJECT,
    )
    .await?;
    enforce_rate_limit(
        &s.db,
        &format!("admin:entitlements:user:{}", v.id),
        limits::API_WRITE_PER_SUBJECT,
    )
    .await?;
    if product.is_empty() || product.len() > 64 || product.chars().any(char::is_control) {
        return Err(shared::invalid("productId"));
    }
    if catalog.get(&product).is_none() {
        return Err(shared::invalid("productId"));
    }
    let expiry = expiry
        .map(|s| {
            if s.len() > 64 {
                return Err(shared::invalid("expiresAt"));
            }
            OffsetDateTime::parse(&s, &Rfc3339).map_err(|_| shared::invalid("expiresAt"))
        })
        .transpose()?;
    if expiry.is_some_and(|e| e <= OffsetDateTime::now_utc()) {
        return Err(shared::invalid("expiresAt"));
    }
    let mut tx = s.db.begin().await?;
    security::lock_users_in_order(&mut tx, v.id, user).await?;
    security::require_step_up(&mut tx, &s, &v).await?;
    let exists: bool = sqlx::query_scalar(
        "select exists(select 1 from users where id=$1 and status='active' and deleted_at is null)",
    )
    .bind(user)
    .fetch_one(&mut *tx)
    .await?;
    if !exists {
        return Err(AppError::not_found());
    }
    let before: Option<Value> = sqlx::query_scalar("select jsonb_build_object('status',status,'currentPeriodEnd',current_period_end,'adminOverrideStatus',admin_override_status,'adminOverrideExpiresAt',admin_override_expires_at) from entitlements where user_id=$1 and product_id=$2 for update").bind(user).bind(&product).fetch_optional(&mut *tx).await?;
    let status = if grant { "active" } else { "revoked" };
    let after: Value = sqlx::query_scalar("insert into entitlements(user_id,product_id,status,current_period_end,synced_at,admin_override_status,admin_override_expires_at) values($1,$2,$3,$4,now(),$3,$4) on conflict(user_id,product_id) do update set status=excluded.status,current_period_end=excluded.current_period_end,admin_override_status=excluded.admin_override_status,admin_override_expires_at=excluded.admin_override_expires_at,updated_at=now() returning jsonb_build_object('status',status,'currentPeriodEnd',current_period_end,'adminOverrideStatus',admin_override_status,'adminOverrideExpiresAt',admin_override_expires_at)").bind(user).bind(&product).bind(status).bind(expiry).fetch_one(&mut *tx).await?;
    audit::audit_before_after(
        &mut tx,
        &m,
        &v,
        if grant {
            "admin.entitlement.grant"
        } else {
            "admin.entitlement.revoke"
        },
        ("user", &user.to_string()),
        json!({"productId":product,"entitlement":before}),
        json!({"productId":product,"entitlement":after}),
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
pub(crate) async fn grant(
    State(s): State<AppState>,
    AdminViewer(v): AdminViewer,
    Extension(catalog): Extension<Arc<Catalog>>,
    m: RequestMeta,
    JsonBody(i): JsonBody<Grant>,
) -> AppResult<StatusCode> {
    change(
        (s, catalog),
        v,
        m,
        i.user_id,
        i.product_id,
        i.expires_at,
        true,
    )
    .await
}
pub(crate) async fn revoke(
    State(s): State<AppState>,
    AdminViewer(v): AdminViewer,
    Extension(catalog): Extension<Arc<Catalog>>,
    m: RequestMeta,
    JsonBody(i): JsonBody<Revoke>,
) -> AppResult<StatusCode> {
    change((s, catalog), v, m, i.user_id, i.product_id, None, false).await
}
