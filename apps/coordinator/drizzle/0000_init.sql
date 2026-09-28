CREATE TABLE "contributions" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"tasks_completed" integer DEFAULT 0 NOT NULL,
	"tasks_validated" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"local_inference_ms" bigint DEFAULT 0 NOT NULL,
	"total_execution_ms" bigint DEFAULT 0 NOT NULL,
	"api_cost_usd" double precision DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"version" text NOT NULL,
	"category" text NOT NULL,
	"input_schema" jsonb NOT NULL,
	"output_schema" jsonb NOT NULL,
	"prompt" jsonb NOT NULL,
	"requirements" jsonb NOT NULL,
	"validation" jsonb NOT NULL,
	"local_models_only" boolean NOT NULL,
	"minimum_context_window" integer NOT NULL,
	"validation_mode" text NOT NULL,
	"replication_factor" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "results" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"worker_id" text NOT NULL,
	"lease_id" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"result" jsonb NOT NULL,
	"result_hash" text NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"duration_ms" integer NOT NULL,
	"cost_usd" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_leases" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"worker_id" text NOT NULL,
	"leased_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"replication_factor" integer NOT NULL,
	"active_leases" integer DEFAULT 0 NOT NULL,
	"completed_replicas" integer DEFAULT 0 NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"consensus_key" text,
	"accepted_result_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "tasks_counters_nonnegative" CHECK ("tasks"."active_leases" >= 0 AND "tasks"."completed_replicas" >= 0)
);
--> statement-breakpoint
CREATE TABLE "validations" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"worker_id" text,
	"outcome" text NOT NULL,
	"detail" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_capabilities" (
	"worker_id" text NOT NULL,
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"models" jsonb NOT NULL,
	CONSTRAINT "worker_capabilities_worker_id_provider_pk" PRIMARY KEY("worker_id","provider")
);
--> statement-breakpoint
CREATE TABLE "workers" (
	"id" text PRIMARY KEY NOT NULL,
	"secret_hash" text NOT NULL,
	"platform" text NOT NULL,
	"client_version" text NOT NULL,
	"protocol_version" text NOT NULL,
	"status" text DEFAULT 'available' NOT NULL,
	"current_tasks" integer DEFAULT 0 NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contributions" ADD CONSTRAINT "contributions_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "results" ADD CONSTRAINT "results_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "results" ADD CONSTRAINT "results_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "results" ADD CONSTRAINT "results_lease_id_task_leases_id_fk" FOREIGN KEY ("lease_id") REFERENCES "public"."task_leases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_leases" ADD CONSTRAINT "task_leases_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_leases" ADD CONSTRAINT "task_leases_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validations" ADD CONSTRAINT "validations_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validations" ADD CONSTRAINT "validations_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_capabilities" ADD CONSTRAINT "worker_capabilities_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "results_task_worker_uq" ON "results" USING btree ("task_id","worker_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_leases_task_worker_uq" ON "task_leases" USING btree ("task_id","worker_id");--> statement-breakpoint
CREATE INDEX "task_leases_active_expiry_idx" ON "task_leases" USING btree ("expires_at") WHERE "task_leases"."status" = 'active';--> statement-breakpoint
CREATE INDEX "task_leases_worker_idx" ON "task_leases" USING btree ("worker_id");--> statement-breakpoint
CREATE INDEX "tasks_leasable_idx" ON "tasks" USING btree ("status","priority","created_at");--> statement-breakpoint
CREATE INDEX "tasks_project_idx" ON "tasks" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "validations_task_idx" ON "validations" USING btree ("task_id");