use super::*;
use sqlx::QueryBuilder;

pub(super) fn router() -> Router<AppState> {
    Router::new()
        .route("/notifications", get(list))
        .route("/notifications/count", get(count))
        .route("/notifications/read", axum::routing::post(read))
        .route("/activity", get(activity))
}

// All names come from the validated registry and are bound as parameters.
fn visible<'a>(
    b: &mut QueryBuilder<'a, Postgres>,
    registry: &'a EntityRegistry,
    viewer: &'a Viewer,
    s: &AppState,
    feed: bool,
) {
    b.push(" a.deleted_at is null and a.status='active' and ((x.kind='follow' and x.record_id is null and ");
    if feed {
        b.push("exists(select 1 from users t where t.id=x.target_user_id and t.deleted_at is null and t.status='active')");
    } else {
        b.push("true");
    }
    b.push(") or (x.record_id is not null and r.id is not null and r.deleted_at is null and owner.deleted_at is null and (x.comment_id is null or (c.id is not null and c.deleted_at is null and c.admin_hidden_at is null)) and (");
    let mut first = true;
    for (name, d) in registry.definitions() {
        let Some(social) = &d.social else { continue };
        if !social.comments && social.reactions.is_empty() {
            continue;
        }
        if !first {
            b.push(" or ");
        }
        first = false;
        b.push("(r.entity=")
            .push_bind(name)
            .push(" and x.entity=r.entity and (");
        if social.comments {
            b.push("x.kind in ('comment','reply')");
        } else {
            b.push("false");
        }
        if !social.reactions.is_empty() {
            b.push(" or (x.kind='reaction' and x.reaction_kind = any(")
                .push_bind(social.reactions.clone())
                .push("))");
        }
        b.push(") and ");
        if feed {
            b.push("r.team_id is null and r.admin_hidden_at is null and ");
            if d.read == ReadAccess::Public {
                b.push("true");
            } else if d.allow_public {
                b.push("r.visibility='public'");
            } else {
                b.push("false");
            }
        } else {
            // Both parties must remain members of a live team.
            b.push("((r.team_id is not null and exists(select 1 from teams t join team_members mr on mr.team_id=t.id join team_members ma on ma.team_id=t.id where t.id=r.team_id and t.deleted_at is null and mr.user_id=")
                .push_bind(viewer.id)
                .push(" and ma.user_id=a.id)) or (r.team_id is null and ");
            let public = d.read == ReadAccess::Public || d.read == ReadAccess::Authenticated;
            if public {
                b.push("true");
            } else {
                b.push("(");
                if d.allow_public {
                    b.push("r.visibility='public' or ");
                }
                if viewer.is_admin() {
                    b.push("true");
                } else {
                    b.push("r.owner_id=").push_bind(viewer.id);
                }
                b.push(") and (");
                if d.allow_public {
                    b.push("r.visibility='public' or ");
                }
                b.push("r.owner_id=a.id or a.role='admin' or lower(a.email::text) = any(")
                    .push_bind(s.config.admin_emails.iter().cloned().collect::<Vec<_>>())
                    .push("))");
            }
            b.push(")) and (r.admin_hidden_at is null or ((r.owner_id=")
                .push_bind(viewer.id)
                .push(" or ");
            if viewer.is_admin() {
                b.push("true");
            } else {
                b.push("false");
            }
            b.push(") and (r.owner_id=a.id or a.role='admin' or lower(a.email::text) = any(")
                .push_bind(s.config.admin_emails.iter().cloned().collect::<Vec<_>>())
                .push("))))");
        }
        b.push(")");
    }
    if first {
        b.push("false");
    }
    b.push(")))");
}
fn joins(b: &mut QueryBuilder<'_, Postgres>) {
    b.push(" join users a on a.id=x.actor_id left join records r on r.id=x.record_id left join users owner on owner.id=r.owner_id left join social_comments c on c.id=x.comment_id ");
}
fn page(p: Page) -> AppResult<(i64, Option<Uuid>)> {
    let limit = p.limit.unwrap_or(20);
    if !(1..=100).contains(&limit) {
        return Err(invalid("limit", "Use a value from 1 to 100."));
    }
    Ok((i64::from(limit), p.cursor))
}
#[derive(FromRow)]
struct Item {
    id: Uuid,
    kind: String,
    actor_id: Uuid,
    display_name: String,
    entity: Option<String>,
    record_id: Option<Uuid>,
    comment_id: Option<Uuid>,
    target_user_id: Option<Uuid>,
    read_at: Option<OffsetDateTime>,
    created_at: OffsetDateTime,
}
impl Item {
    fn json(&self, feed: bool) -> AppResult<Value> {
        let date = |v: OffsetDateTime| v.format(&Rfc3339).map_err(AppError::internal);
        let mut value = json!({"id":self.id,"kind":self.kind,"actor":{"id":self.actor_id,"displayName":self.display_name},"entity":self.entity,"recordId":self.record_id,"commentId":self.comment_id,"createdAt":date(self.created_at)?});
        if feed {
            value["targetUserId"] = json!(self.target_user_id);
        } else {
            value["readAt"] = json!(self.read_at.map(date).transpose()?);
        }
        Ok(value)
    }
}
async fn cursor_exists(
    s: &AppState,
    v: &Viewer,
    cursor: Option<Uuid>,
    feed: bool,
) -> AppResult<()> {
    if let Some(id) = cursor {
        let sql = if feed {
            "select exists(select 1 from social_activity x join social_follows f on f.followed_id=x.actor_id where x.id=$1 and f.follower_id=$2)"
        } else {
            "select exists(select 1 from social_notifications where id=$1 and recipient_id=$2)"
        };
        let exists: bool = sqlx::query_scalar(sql)
            .bind(id)
            .bind(v.id)
            .fetch_one(&s.db)
            .await?;
        if !exists {
            return Err(invalid("cursor", "Use a valid cursor."));
        }
    }
    Ok(())
}
async fn fetch(
    s: &AppState,
    r: &EntityRegistry,
    v: &Viewer,
    p: Page,
    feed: bool,
) -> AppResult<Value> {
    let (limit, cursor) = page(p)?;
    cursor_exists(s, v, cursor, feed).await?;
    let table = if feed {
        "social_activity"
    } else {
        "social_notifications"
    };
    let mut b = QueryBuilder::<Postgres>::new(
        "select x.id,x.kind,a.id actor_id,a.display_name,x.entity,x.record_id,x.comment_id,",
    );
    b.push(if feed {
        "x.target_user_id, null::timestamptz read_at"
    } else {
        "null::uuid target_user_id, x.read_at"
    });
    b.push(",x.created_at from ").push(table).push(" x ");
    joins(&mut b);
    b.push(" where ");
    if feed {
        b.push("exists(select 1 from social_follows f where f.follower_id=")
            .push_bind(v.id)
            .push(" and f.followed_id=x.actor_id) and ");
    } else {
        b.push("x.recipient_id=").push_bind(v.id).push(" and ");
    }
    visible(&mut b, r, v, s, feed);
    if let Some(id) = cursor {
        b.push(" and (x.created_at,x.id) < (select created_at,id from ")
            .push(table)
            .push(" where id=")
            .push_bind(id)
            .push(")");
    }
    b.push(" order by x.created_at desc,x.id desc limit ")
        .push_bind(limit + 1);
    let mut rows = b.build_query_as::<Item>().fetch_all(&s.db).await?;
    let next = if rows.len() > limit as usize {
        rows.truncate(limit as usize);
        rows.last().map(|x| x.id)
    } else {
        None
    };
    let data = rows
        .iter()
        .map(|x| x.json(feed))
        .collect::<AppResult<Vec<_>>>()?;
    if feed {
        Ok(json!({"data":data,"meta":{"nextCursor":next}}))
    } else {
        Ok(json!({"data":data,"meta":{"nextCursor":next,"unreadCount":unread(s,r,v).await?}}))
    }
}
async fn unread(s: &AppState, r: &EntityRegistry, v: &Viewer) -> AppResult<i64> {
    let mut b = QueryBuilder::<Postgres>::new("select count(*) from social_notifications x ");
    joins(&mut b);
    b.push(" where x.recipient_id=")
        .push_bind(v.id)
        .push(" and x.read_at is null and ");
    visible(&mut b, r, v, s, false);
    Ok(b.build_query_scalar().fetch_one(&s.db).await?)
}
async fn list(
    State(s): State<AppState>,
    Extension(r): Extension<Arc<EntityRegistry>>,
    v: Viewer,
    Query(p): Query<Page>,
) -> AppResult<Json<Value>> {
    Ok(Json(fetch(&s, &r, &v, p, false).await?))
}
async fn activity(
    State(s): State<AppState>,
    Extension(r): Extension<Arc<EntityRegistry>>,
    v: Viewer,
    Query(p): Query<Page>,
) -> AppResult<Json<Value>> {
    Ok(Json(fetch(&s, &r, &v, p, true).await?))
}
async fn count(
    State(s): State<AppState>,
    Extension(r): Extension<Arc<EntityRegistry>>,
    v: Viewer,
) -> AppResult<Json<Value>> {
    Ok(Json(
        json!({"data":{"unreadCount":unread(&s,&r,&v).await?}}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadInput {
    ids: Option<Vec<Uuid>>,
    all: Option<bool>,
}
async fn read(
    State(s): State<AppState>,
    Extension(r): Extension<Arc<EntityRegistry>>,
    v: Viewer,
    m: RequestMeta,
    Body(input): Body<ReadInput>,
) -> AppResult<StatusCode> {
    if !matches!((&input.ids,input.all), (Some(ids), None) if ids.len() <= 100)
        && !matches!((&input.ids, input.all), (None, Some(true)))
    {
        return Err(invalid("ids", "Provide up to 100 IDs or all: true."));
    }
    write_limit(&s, &v, &m).await?;
    let mut b = QueryBuilder::<Postgres>::new(
        "update social_notifications set read_at=now() where id in (select x.id from social_notifications x ",
    );
    joins(&mut b);
    b.push(" where x.recipient_id=")
        .push_bind(v.id)
        .push(" and x.read_at is null and ");
    visible(&mut b, &r, &v, &s, false);
    if let Some(ids) = input.ids {
        b.push(" and x.id = any(").push_bind(ids).push(")");
    }
    b.push(")");
    b.build().execute(&s.db).await?;
    audit(&s, &v, &m, "social.notifications.read", v.id).await;
    Ok(StatusCode::NO_CONTENT)
}

// The stream must use exactly the same joins and predicate as the inbox.
pub(super) async fn notification_by_id(
    s: &AppState,
    r: &EntityRegistry,
    v: &Viewer,
    id: Uuid,
) -> AppResult<Option<Value>> {
    let mut b = QueryBuilder::<Postgres>::new(
        "select x.id,x.kind,a.id actor_id,a.display_name,x.entity,x.record_id,x.comment_id,null::uuid target_user_id,x.read_at,x.created_at from social_notifications x ",
    );
    joins(&mut b);
    b.push(" where x.recipient_id=")
        .push_bind(v.id)
        .push(" and x.id=")
        .push_bind(id)
        .push(" and ");
    visible(&mut b, r, v, s, false);
    b.build_query_as::<Item>()
        .fetch_optional(&s.db)
        .await?
        .map(|item| item.json(false))
        .transpose()
}
