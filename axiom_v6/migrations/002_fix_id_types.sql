-- ╔══════════════════════════════════════════════════════════════╗
-- ║  AXIOM v6 — Fix ID Column Types (INT → VARCHAR(36))        ║
-- ║  Migration: 002_fix_id_types.sql                            ║
-- ╚══════════════════════════════════════════════════════════════╝

-- Server.js uses crypto.randomUUID() which generates UUID strings.
-- The original schema used INT AUTO_INCREMENT which cannot store UUIDs.

SET FOREIGN_KEY_CHECKS = 0;

-- Fix users.id
ALTER TABLE users MODIFY COLUMN id VARCHAR(36) NOT NULL;

-- Fix payments columns that reference users
ALTER TABLE payments MODIFY COLUMN id VARCHAR(36) NOT NULL;
ALTER TABLE payments MODIFY COLUMN user_id VARCHAR(36);

-- Fix usage_log columns that reference users
ALTER TABLE usage_log MODIFY COLUMN id VARCHAR(36) NOT NULL;
ALTER TABLE usage_log MODIFY COLUMN user_id VARCHAR(36);

-- Fix audit_log user_id
ALTER TABLE audit_log MODIFY COLUMN user_id VARCHAR(36);

-- Fix collab_sessions owner_id
ALTER TABLE collab_sessions MODIFY COLUMN owner_id VARCHAR(36);

-- Fix user_settings user_id
ALTER TABLE user_settings MODIFY COLUMN user_id VARCHAR(36);

SET FOREIGN_KEY_CHECKS = 1;
