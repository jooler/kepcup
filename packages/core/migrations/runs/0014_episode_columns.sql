-- D92 T1a: chain_id / chain_depth -> episode_id / episode_hop.
ALTER TABLE runs RENAME COLUMN chain_id TO episode_id;
ALTER TABLE runs RENAME COLUMN chain_depth TO episode_hop;
