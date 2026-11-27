use kernel::{AppResult, AppState, crypto};
use secrecy::ExposeSecret;

fn digest(state: &AppState, email: &str, purpose: &str, code: &str) -> [u8; 32] {
    crypto::hmac_sha256(
        state.config.code_pepper.expose_secret().as_bytes(),
        &[
            b"email-code",
            purpose.as_bytes(),
            email.as_bytes(),
            code.as_bytes(),
        ],
    )
}
pub async fn issue(
    state: &AppState,
    email: &str,
    purpose: &str,
    cooldown: bool,
) -> AppResult<Option<String>> {
    let code = crypto::random_digits(6);
    let hash = digest(state, email, purpose, &code);
    let row = sqlx::query("insert into email_codes (email,purpose,code_hash,expires_at) values ($1,$2,$3,now()+interval '15 minutes') on conflict (email,purpose) do update set code_hash=excluded.code_hash, attempts=0, created_at=now(), expires_at=excluded.expires_at where not $4 or email_codes.created_at <= now()-interval '30 seconds'")
        .bind(email).bind(purpose).bind(hash.as_slice()).bind(cooldown).execute(&state.db).await?;
    Ok((row.rows_affected() == 1).then_some(code))
}
pub async fn check(state: &AppState, email: &str, purpose: &str, code: &str) -> AppResult<bool> {
    let hash: Option<Vec<u8>> = sqlx::query_scalar("update email_codes set attempts=attempts+1 where email=$1 and purpose=$2 and attempts<5 and expires_at>now() returning code_hash")
        .bind(email).bind(purpose).fetch_optional(&state.db).await?;
    let expected = digest(state, email, purpose, code);
    if !hash
        .as_ref()
        .is_some_and(|hash| crypto::constant_time_eq(hash, &expected))
    {
        return Ok(false);
    }
    let deleted = sqlx::query("delete from email_codes where email=$1 and purpose=$2 and code_hash=$3 and expires_at>now()")
        .bind(email).bind(purpose).bind(expected.as_slice()).execute(&state.db).await?;
    Ok(deleted.rows_affected() == 1)
}
