-- The plan ladder grew from two rungs to four, and the middle one was renamed.
--
-- `pro` was the only paid id the code ever knew, and the pricing document had
-- already settled on `team` for it — a name that says who it is for rather than
-- that it is the expensive one. Renaming it in the enum without renaming it in
-- the data would silently drop every paying team back to free defaults, because
-- an unknown plan id resolves to `free`.
UPDATE "teams" SET "plan" = 'team' WHERE "plan" = 'pro';
