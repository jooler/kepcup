-- D92 T1a: prepare legacy group conversations for the 'project' type.
-- A project needs a lead. Groups with no active non-butler member (and D60 "creating" leftovers)
-- cannot be converted and are removed here; foreign_keys is ON, so child rows cascade.
DELETE FROM messages_fts WHERE conversation_id IN (
  SELECT c.id FROM conversations c
   WHERE c.type = 'group'
     AND (c.setup_state IS NOT NULL
          OR NOT EXISTS (
               SELECT 1 FROM conversation_members m JOIN bots b ON b.id = m.bot_id
                WHERE m.conversation_id = c.id AND b.status = 'active' AND COALESCE(b.system_role, '') <> 'butler')));

DELETE FROM conversations
 WHERE type = 'group'
   AND (setup_state IS NOT NULL
        OR NOT EXISTS (
             SELECT 1 FROM conversation_members m JOIN bots b ON b.id = m.bot_id
              WHERE m.conversation_id = conversations.id AND b.status = 'active' AND COALESCE(b.system_role, '') <> 'butler'));
