//! Moderator tools for social comments. There are no HTTP routes here: the admin
//! crate calls these functions inside its own step-up check, audit write and transaction.

use kernel::{AppError, AppResult};
use serde_json::{Value, json};
use sqlx::{FromRow, PgPool, Postgres, QueryBuilder, Transaction};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

/// Hides or restores a comment for everyone except moderators.
///
/// Hiding keeps the original hide time if the comment is already hidden. Restoring
/// clears the flag. Authors have no route to this function, so they cannot unhide.
pub async fn set_comment_admin_hidden(
    tx: &mut Transaction<'_, Postgres>,
    comment_id: Uuid,
    hidden: bool,
) -> AppResult<()> {
    let result = sqlx::query(
        "update social_comments set admin_hidden_at=case when $2::boolean then coalesce(admin_hidden_at, now()) else null end where id=$1",
    )
    .bind(comment_id)
    .bind(hidden)
    .execute(&mut **tx)
    .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::not_found());
    }
    Ok(())
}

/// A comment as a moderator sees it. This type is for moderation only and must not
/// be returned from an ordinary route. Unlike the public comment JSON, it includes
/// the body of a hidden comment.
#[derive(FromRow)]
pub struct AdminComment {
    pub id: Uuid,
    pub entity: String,
    pub record_id: Uuid,
    pub author_id: Uuid,
    pub parent_id: Option<Uuid>,
    body: String,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
    pub deleted_at: Option<OffsetDateTime>,
    pub admin_hidden_at: Option<OffsetDateTime>,
}

impl AdminComment {
    /// The body is `None` only for an author-deleted comment that is not hidden,
    /// which keeps the deleted-placeholder rule. Hidden text stays readable here so
    /// a moderator can review it, even after the author deletes it.
    pub fn body(&self) -> Option<&str> {
        if self.deleted_at.is_some() && self.admin_hidden_at.is_none() {
            None
        } else {
            Some(&self.body)
        }
    }

    pub fn json(&self) -> AppResult<Value> {
        let date = |d: OffsetDateTime| d.format(&Rfc3339).map_err(AppError::internal);
        Ok(json!({
            "id": self.id,
            "entity": self.entity,
            "recordId": self.record_id,
            "authorId": self.author_id,
            "parentId": self.parent_id,
            "body": self.body(),
            "hidden": self.admin_hidden_at.is_some(),
            "hiddenAt": self.admin_hidden_at.map(date).transpose()?,
            "createdAt": date(self.created_at)?,
            "updatedAt": date(self.updated_at)?,
            "deletedAt": self.deleted_at.map(date).transpose()?,
        }))
    }
}

/// Filters for the moderation list. Every field is optional and bound as a parameter.
#[derive(Default)]
pub struct CommentFilter {
    pub entity: Option<String>,
    pub record_id: Option<Uuid>,
    pub hidden: Option<bool>,
    pub deleted: Option<bool>,
}

pub struct CommentPage {
    pub items: Vec<AdminComment>,
    pub next_cursor: Option<Uuid>,
}

/// Lists comments for moderators, newest first. `limit` must be 1 to 100.
/// The cursor is the ID of the last item on the previous page.
pub async fn list_comments(
    db: &PgPool,
    filter: &CommentFilter,
    limit: u32,
    cursor: Option<Uuid>,
) -> AppResult<CommentPage> {
    if !(1..=100).contains(&limit) {
        return Err(super::invalid("limit", "Use a value from 1 to 100."));
    }
    if let Some(id) = cursor {
        let exists: bool =
            sqlx::query_scalar("select exists(select 1 from social_comments where id=$1)")
                .bind(id)
                .fetch_one(db)
                .await?;
        if !exists {
            return Err(super::invalid("cursor", "Use a valid cursor."));
        }
    }
    let mut b = QueryBuilder::<Postgres>::new(
        "select c.id,c.entity,c.record_id,c.author_id,c.parent_id,c.body,c.created_at,c.updated_at,c.deleted_at,c.admin_hidden_at from social_comments c where true",
    );
    if let Some(entity) = &filter.entity {
        b.push(" and c.entity=").push_bind(entity.clone());
    }
    if let Some(record_id) = filter.record_id {
        b.push(" and c.record_id=").push_bind(record_id);
    }
    if let Some(hidden) = filter.hidden {
        b.push(if hidden {
            " and c.admin_hidden_at is not null"
        } else {
            " and c.admin_hidden_at is null"
        });
    }
    if let Some(deleted) = filter.deleted {
        b.push(if deleted {
            " and c.deleted_at is not null"
        } else {
            " and c.deleted_at is null"
        });
    }
    if let Some(id) = cursor {
        b.push(" and (c.created_at,c.id) < (select created_at,id from social_comments where id=")
            .push_bind(id)
            .push(")");
    }
    b.push(" order by c.created_at desc,c.id desc limit ")
        .push_bind(i64::from(limit) + 1);
    let mut items = b.build_query_as::<AdminComment>().fetch_all(db).await?;
    let next_cursor = if items.len() > limit as usize {
        items.truncate(limit as usize);
        items.last().map(|item| item.id)
    } else {
        None
    };
    Ok(CommentPage { items, next_cursor })
}

/// Reads one comment for moderators, including a hidden body. Returns `None` if the
/// comment does not exist.
pub async fn get_comment(db: &PgPool, id: Uuid) -> AppResult<Option<AdminComment>> {
    Ok(sqlx::query_as::<_, AdminComment>(
        "select id,entity,record_id,author_id,parent_id,body,created_at,updated_at,deleted_at,admin_hidden_at from social_comments where id=$1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?)
}
