# Team records interface

`Record::team_id` is `Option<Uuid>` and JSON includes `teamId`. Use async `Record::can_read(db, definition, viewer)` and `can_write(db, definition, viewer)` for team-aware checks; synchronous checks deny team records. `ListQuery::team_id` selects a team only with `scope=team`. `api::create_in_team_tx` accepts the same arguments as `create_in_tx` followed by `team_id: Uuid`. Existing create APIs create personal records. `maxPerOwner` applies per owner, entity, and workspace: personal records and each team have independent caps.
