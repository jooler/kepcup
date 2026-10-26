-- D104: preset skills are now the 'com.kepcup/starter-skills' built-in plugin.
-- Rewrite the library source marker so already-installed presets keep being recognised
-- (SkillPresetsService treats rows whose source_url starts with the new prefix as its own).
UPDATE skill_library
   SET source_url = 'plugin://com.kepcup/starter-skills/' || substr(source_url, length('preset://') + 1)
 WHERE source_url LIKE 'preset://%';
