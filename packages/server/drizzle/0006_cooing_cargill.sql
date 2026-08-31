-- One announcements channel per team: before the unique index below existed,
-- concurrent first-announces could create duplicate channels. Keep the earliest
-- channel per team, repoint messages at it, copy read markers over, then delete
-- the duplicates (cascade clears their leftover read_state rows). Every
-- statement is a no-op when there are no duplicates.
WITH keep AS (
	SELECT team_id, (array_agg(id ORDER BY created_at, id))[1] AS keep_id
	FROM debug_sessions WHERE kind = 'announcements' GROUP BY team_id
), dup AS (
	SELECT s.id, keep.keep_id
	FROM debug_sessions s
	JOIN keep ON keep.team_id = s.team_id
	WHERE s.kind = 'announcements' AND s.id <> keep.keep_id
)
UPDATE messages m SET session_id = dup.keep_id FROM dup WHERE m.session_id = dup.id;
--> statement-breakpoint
WITH keep AS (
	SELECT team_id, (array_agg(id ORDER BY created_at, id))[1] AS keep_id
	FROM debug_sessions WHERE kind = 'announcements' GROUP BY team_id
), dup AS (
	SELECT s.id, keep.keep_id
	FROM debug_sessions s
	JOIN keep ON keep.team_id = s.team_id
	WHERE s.kind = 'announcements' AND s.id <> keep.keep_id
)
INSERT INTO read_state (user_id, session_id, last_read_at)
SELECT rs.user_id, dup.keep_id, max(rs.last_read_at)
FROM read_state rs
JOIN dup ON dup.id = rs.session_id
GROUP BY rs.user_id, dup.keep_id
ON CONFLICT (user_id, session_id) DO UPDATE
	SET last_read_at = GREATEST(read_state.last_read_at, excluded.last_read_at);
--> statement-breakpoint
WITH keep AS (
	SELECT team_id, (array_agg(id ORDER BY created_at, id))[1] AS keep_id
	FROM debug_sessions WHERE kind = 'announcements' GROUP BY team_id
)
DELETE FROM debug_sessions s
USING keep
WHERE s.kind = 'announcements' AND s.team_id = keep.team_id AND s.id <> keep.keep_id;
--> statement-breakpoint
CREATE UNIQUE INDEX "debug_sessions_team_announcements" ON "debug_sessions" USING btree ("team_id") WHERE kind = 'announcements';