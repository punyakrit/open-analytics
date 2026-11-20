-- "When did this crawler last come?" (Search & AI insights) without scanning every crawler visit.
CREATE INDEX crawls_site_agent ON crawls (site_id, agent, ts);
