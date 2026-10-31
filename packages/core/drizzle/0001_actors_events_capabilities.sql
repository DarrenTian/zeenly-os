CREATE TYPE "public"."actor_kind" AS ENUM('unit', 'human', 'system');--> statement-breakpoint
CREATE TYPE "public"."capability_level" AS ENUM('root', 'parent', 'self');--> statement-breakpoint
CREATE TABLE "events" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_kind" "actor_kind" NOT NULL,
	"actor_id" text NOT NULL,
	"what" text NOT NULL,
	"on_kind" text NOT NULL,
	"on_id" text NOT NULL,
	"unit_id" text,
	"why" text,
	"before" jsonb,
	"after" jsonb
);
--> statement-breakpoint
CREATE TABLE "tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hash" text NOT NULL,
	"actor_kind" "actor_kind" NOT NULL,
	"actor_id" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tokens_hash_unique" UNIQUE("hash")
);
--> statement-breakpoint
CREATE TABLE "unit_capabilities" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "unit_capabilities_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"unit_id" text NOT NULL,
	"tool" text NOT NULL,
	"scope" text DEFAULT '' NOT NULL,
	"level" "capability_level" DEFAULT 'root' NOT NULL,
	"approvals" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "unit_capabilities" ADD CONSTRAINT "unit_capabilities_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_unit_idx" ON "events" USING btree ("unit_id","id");--> statement-breakpoint
CREATE INDEX "events_on_idx" ON "events" USING btree ("on_kind","on_id");--> statement-breakpoint
CREATE UNIQUE INDEX "unit_capabilities_idx" ON "unit_capabilities" USING btree ("unit_id","tool","scope");--> statement-breakpoint
ALTER TABLE "units" DROP COLUMN "charter";