-- Migration: Add free tier support
-- Adds is_free flag to slots, buildings, graveyard_plots (the immutable layout rows).
-- Adds free_claim_used flag to companies to track 1 free claim per company.
--
-- NOTE: is_free deliberately does NOT live on `holdings`. A holding row is the *occupancy*
-- of a slot; the free-tier flag is a property of the slot itself. See migration 002.

-- Add is_free column to slots (default FALSE = paid)
ALTER TABLE slots ADD COLUMN IF NOT EXISTS is_free BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS slots_is_free_idx ON slots (is_free);

-- Add is_free column to buildings (default FALSE = paid)
ALTER TABLE buildings ADD COLUMN IF NOT EXISTS is_free BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS buildings_is_free_idx ON buildings (is_free);

-- Add is_free column to graveyard_plots (default FALSE = paid)
ALTER TABLE graveyard_plots ADD COLUMN IF NOT EXISTS is_free BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS graveyard_plots_is_free_idx ON graveyard_plots (is_free);

-- Add free_claim_used column to companies (tracks if company used their 1 free claim)
ALTER TABLE companies ADD COLUMN IF NOT EXISTS free_claim_used BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS companies_free_claim_used_idx ON companies (free_claim_used);
