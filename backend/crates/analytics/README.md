# Analytics API

`GET /api/v1/entities/{entity}/stats?metric=count&groupBy=createdAt:day&scope=mine`

Example response: `{"data":[{"key":"2026-03-08T00:00:00Z","value":3}],"meta":{"metric":"count","groupBy":"createdAt:day"}}`. Without `groupBy`, one row has a null key, even for an empty result. A grouped empty result has no rows. Count counts records including those with missing or null grouping fields. Other aggregates ignore missing and null values and return null if no numeric values remain. Missing and null scalar grouping values share a null group. Results are sorted by key; more than 200 groups returns `LIMIT_REACHED`.

`metric` is required: `count`, `sum:field`, `avg:field`, `min:field`, or `max:field`. Numeric fields must be declared numeric in the entity configuration. `groupBy` may be a filterable scalar field, `createdAt:day`, `createdAt:week`, `createdAt:month`, or a schema `date-time` field followed by one of those buckets. Buckets start at midnight UTC; weeks start Monday. Date-time values may contain offsets. Null or missing bucket values have a null key.

`from` and `to` are RFC3339 timestamps bounding record creation time, inclusive and exclusive respectively. `to` defaults to now and `from` defaults to 30 days before `to`. The window must be positive and no longer than 366 days. Encode `+` in timestamp offsets as `%2B`.

`scope=mine` is the default and requires authentication; `scope=public` and `scope=all` follow records list rules, with `all` restricted to administrators. Deleted records and records belonging to deleted users are excluded. Filters use records list syntax and types, for example `filter[flag]=true` or `filter[category]=open`. Unknown or repeated parameters are rejected. Query strings are limited to 8192 bytes and each value to 2048 bytes.

Example: `/api/v1/entities/orders/stats?metric=sum:amount&groupBy=category&filter[paid]=true&from=2026-03-01T00%3A00%3A00Z&to=2026-04-01T00%3A00%3A00Z`.

