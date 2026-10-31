CREATE TYPE "public"."assignment_kind" AS ENUM('directive', 'request');--> statement-breakpoint
CREATE TYPE "public"."assignment_state" AS ENUM('new', 'proposed', 'active', 'declined', 'closed');--> statement-breakpoint
CREATE TYPE "public"."directive_status" AS ENUM('open', 'done', 'dropped');--> statement-breakpoint
CREATE TYPE "public"."message_kind" AS ENUM('request', 'escalation', 'note');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('open', 'resolved', 'declined');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('ok', 'risk', 'stuck', 'idle');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('open', 'doing', 'done', 'dropped');--> statement-breakpoint
CREATE TYPE "public"."unit_mode" AS ENUM('steer', 'autopilot');--> statement-breakpoint
CREATE TABLE "directive_assignments" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "directive_assignments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"directive_id" integer NOT NULL,
	"unit_id" text NOT NULL,
	"kind" "assignment_kind" NOT NULL,
	"state" "assignment_state" DEFAULT 'new' NOT NULL,
	"translation" text,
	"note" text,
	"needs_confirm" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "directives" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "directives_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"from_unit" text NOT NULL,
	"parent_id" integer,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"done_when" text NOT NULL,
	"due_on" text,
	"status" "directive_status" DEFAULT 'open' NOT NULL,
	"outcome" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "unit_docs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"unit_id" text NOT NULL,
	"name" text NOT NULL,
	"version" integer NOT NULL,
	"body" text NOT NULL,
	"author" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "unit_messages" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "unit_messages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"kind" "message_kind" NOT NULL,
	"from_unit" text NOT NULL,
	"to_unit" text NOT NULL,
	"path" jsonb NOT NULL,
	"for_person" boolean DEFAULT false NOT NULL,
	"subject" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"directive_id" integer,
	"status" "message_status" DEFAULT 'open' NOT NULL,
	"resolution" text,
	"resolved_by" text,
	"sent_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "unit_reports" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "unit_reports_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"unit_id" text NOT NULL,
	"directive_id" integer,
	"status" "report_status" NOT NULL,
	"headline" jsonb NOT NULL,
	"done" jsonb NOT NULL,
	"blocked" jsonb NOT NULL,
	"next" jsonb NOT NULL,
	"numbers" jsonb NOT NULL,
	"author" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "unit_tasks" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "unit_tasks_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"unit_id" text NOT NULL,
	"title" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"priority" integer DEFAULT 2 NOT NULL,
	"status" "task_status" DEFAULT 'open' NOT NULL,
	"directive_id" integer,
	"source" text NOT NULL,
	"claimed_by" text,
	"pr_url" text,
	"pinned" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "units" (
	"id" text PRIMARY KEY NOT NULL,
	"parent_id" text,
	"name" text NOT NULL,
	"summary" text NOT NULL,
	"charter" text DEFAULT '' NOT NULL,
	"owner" text,
	"mode" "unit_mode" DEFAULT 'steer' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "directive_assignments" ADD CONSTRAINT "directive_assignments_directive_id_directives_id_fk" FOREIGN KEY ("directive_id") REFERENCES "public"."directives"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directive_assignments" ADD CONSTRAINT "directive_assignments_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directives" ADD CONSTRAINT "directives_from_unit_units_id_fk" FOREIGN KEY ("from_unit") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directives" ADD CONSTRAINT "directives_parent_id_directives_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."directives"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_docs" ADD CONSTRAINT "unit_docs_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_messages" ADD CONSTRAINT "unit_messages_from_unit_units_id_fk" FOREIGN KEY ("from_unit") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_messages" ADD CONSTRAINT "unit_messages_to_unit_units_id_fk" FOREIGN KEY ("to_unit") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_messages" ADD CONSTRAINT "unit_messages_directive_id_directives_id_fk" FOREIGN KEY ("directive_id") REFERENCES "public"."directives"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_reports" ADD CONSTRAINT "unit_reports_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_reports" ADD CONSTRAINT "unit_reports_directive_id_directives_id_fk" FOREIGN KEY ("directive_id") REFERENCES "public"."directives"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_tasks" ADD CONSTRAINT "unit_tasks_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_tasks" ADD CONSTRAINT "unit_tasks_directive_id_directives_id_fk" FOREIGN KEY ("directive_id") REFERENCES "public"."directives"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "units" ADD CONSTRAINT "units_parent_id_units_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "directive_assignments_unit_idx" ON "directive_assignments" USING btree ("directive_id","unit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "unit_docs_unit_name_version_idx" ON "unit_docs" USING btree ("unit_id","name","version");--> statement-breakpoint
CREATE INDEX "unit_messages_inbox_idx" ON "unit_messages" USING btree ("to_unit","status");--> statement-breakpoint
CREATE INDEX "unit_reports_unit_idx" ON "unit_reports" USING btree ("unit_id","created_at");--> statement-breakpoint
CREATE INDEX "unit_tasks_unit_idx" ON "unit_tasks" USING btree ("unit_id","status");