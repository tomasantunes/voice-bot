CREATE DATABASE IF NOT EXISTS voice_bot
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE voice_bot;

CREATE TABLE IF NOT EXISTS user_settings (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  username VARCHAR(191) NOT NULL,
  voice VARCHAR(32) NOT NULL DEFAULT 'marin',
  mode VARCHAR(64) NOT NULL DEFAULT 'default',
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_settings_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS meetings (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  username VARCHAR(191) NOT NULL,
  voice VARCHAR(32) NOT NULL,
  mode VARCHAR(64) NOT NULL,
  started_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ended_at TIMESTAMP(3) NULL,
  PRIMARY KEY (id),
  KEY idx_meetings_user_started (username, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  meeting_id BIGINT UNSIGNED NOT NULL,
  client_event_id VARCHAR(191) NOT NULL,
  role ENUM('user', 'assistant') NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_message_event (meeting_id, client_event_id),
  KEY idx_messages_meeting_created (meeting_id, created_at),
  CONSTRAINT fk_messages_meeting FOREIGN KEY (meeting_id)
    REFERENCES meetings (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

