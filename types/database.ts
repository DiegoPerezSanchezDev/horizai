export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

type TableDefinition<
  Row extends Record<string, unknown>,
  Insert extends Record<string, unknown>
> = {
  Row: Row;
  Insert: Insert;
  Update: Partial<Insert>;
  Relationships: [];
};

type ViewDefinition<Row extends Record<string, unknown>> = {
  Row: Row;
  Relationships: [];
};

type EntityRow = {
  id: string;
  entity_type: string;
  canonical_name: string;
  country_code: string | null;
  aliases: string[];
  review_status: string;
  metadata: Json;
  created_at: string;
  updated_at: string;
};

type EntityInsert = {
  id?: string;
  entity_type: string;
  canonical_name: string;
  country_code?: string | null;
  aliases?: string[];
  review_status?: string;
  metadata?: Json;
  created_at?: string;
  updated_at?: string;
};

export type Database = {
  public: {
    Tables: {
      sources: TableDefinition<
        {
          id: string;
          name: string;
          url: string;
          feed_url: string | null;
          discovery_method: string;
          last_checked_at: string | null;
          last_error: string | null;
          source_type: string;
          country_code: string | null;
          language: string;
          priority: number;
          is_active: boolean;
          crawl_interval_minutes: number;
          last_fetched_at: string | null;
          last_success_at: string | null;
          last_error_at: string | null;
          consecutive_failures: number;
          metadata: Json;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          name: string;
          url: string;
          feed_url?: string | null;
          discovery_method?: string;
          last_checked_at?: string | null;
          last_error?: string | null;
          source_type?: string;
          country_code?: string | null;
          language?: string;
          priority?: number;
          is_active?: boolean;
          crawl_interval_minutes?: number;
          last_fetched_at?: string | null;
          last_success_at?: string | null;
          last_error_at?: string | null;
          consecutive_failures?: number;
          metadata?: Json;
          created_at?: string;
          updated_at?: string;
        }
      >;
      raw_items: TableDefinition<
        {
          id: string;
          source_id: string;
          original_url: string;
          canonical_url: string | null;
          external_id: string | null;
          title: string | null;
          excerpt: string | null;
          raw_content: string | null;
          content_type: string;
          language: string | null;
          published_at: string | null;
          discovered_at: string;
          content_hash: string | null;
          extraction_quality: string | null;
          extracted_at: string | null;
          processing_status: string;
          processing_attempts: number;
          last_processed_at: string | null;
          next_retry_at: string | null;
          last_error_at: string | null;
          error_code: string | null;
          error_message: string | null;
          normalized_payload: Json | null;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          source_id: string;
          original_url: string;
          canonical_url?: string | null;
          external_id?: string | null;
          title?: string | null;
          excerpt?: string | null;
          raw_content?: string | null;
          content_type?: string;
          language?: string | null;
          published_at?: string | null;
          discovered_at?: string;
          content_hash?: string | null;
          extraction_quality?: string | null;
          extracted_at?: string | null;
          processing_status?: string;
          processing_attempts?: number;
          last_processed_at?: string | null;
          next_retry_at?: string | null;
          last_error_at?: string | null;
          error_code?: string | null;
          error_message?: string | null;
          normalized_payload?: Json | null;
          created_at?: string;
          updated_at?: string;
        }
      >;
      events: TableDefinition<
        {
          id: string;
          event_key: string | null;
          canonical_title: string;
          event_status: string;
          confidence_score: number | null;
          primary_region_id: string | null;
          primary_country_code: string | null;
          occurred_at: string | null;
          occurred_at_precision: string;
          first_seen_at: string;
          last_seen_at: string | null;
          review_status: string;
          review_notes: string | null;
          classification_payload: Json;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          event_key?: string | null;
          canonical_title: string;
          event_status?: string;
          confidence_score?: number | null;
          primary_region_id?: string | null;
          primary_country_code?: string | null;
          occurred_at?: string | null;
          occurred_at_precision?: string;
          first_seen_at?: string;
          last_seen_at?: string | null;
          review_status?: string;
          review_notes?: string | null;
          classification_payload?: Json;
          created_at?: string;
          updated_at?: string;
        }
      >;
      event_sources: TableDefinition<
        {
          event_id: string;
          raw_item_id: string;
          source_id: string;
          is_primary: boolean;
          created_at: string;
          updated_at: string;
        },
        {
          event_id: string;
          raw_item_id: string;
          source_id: string;
          is_primary?: boolean;
          created_at?: string;
          updated_at?: string;
        }
      >;
      articles: TableDefinition<
        {
          id: string;
          event_id: string;
          slug: string;
          headline_es: string;
          summary_es: string | null;
          why_it_matters_es: string | null;
          body_es: string | null;
          importance_score: number | null;
          confidence_score: number | null;
          publication_status: string;
          critic_status: string;
          critic_score: number | null;
          critic_notes: string | null;
          revision_count: number;
          generated_at: string | null;
          reviewed_at: string | null;
          published_at: string | null;
          rejection_reason: string | null;
          metadata: Json;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          event_id: string;
          slug: string;
          headline_es: string;
          summary_es?: string | null;
          why_it_matters_es?: string | null;
          body_es?: string | null;
          importance_score?: number | null;
          confidence_score?: number | null;
          publication_status?: string;
          critic_status?: string;
          critic_score?: number | null;
          critic_notes?: string | null;
          revision_count?: number;
          generated_at?: string | null;
          reviewed_at?: string | null;
          published_at?: string | null;
          rejection_reason?: string | null;
          metadata?: Json;
          created_at?: string;
          updated_at?: string;
        }
      >;
      regions: TableDefinition<
        {
          id: string;
          code: string;
          name: string;
          latitude: number | null;
          longitude: number | null;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          code: string;
          name: string;
          latitude?: number | null;
          longitude?: number | null;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        }
      >;
      categories: TableDefinition<
        {
          id: string;
          slug: string;
          name: string;
          description: string | null;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          slug: string;
          name: string;
          description?: string | null;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        }
      >;
      article_categories: TableDefinition<
        {
          article_id: string;
          category_id: string;
          is_primary: boolean;
          confidence_score: number | null;
          created_at: string;
          updated_at: string;
        },
        {
          article_id: string;
          category_id: string;
          is_primary?: boolean;
          confidence_score?: number | null;
          created_at?: string;
          updated_at?: string;
        }
      >;
      entities: TableDefinition<EntityRow, EntityInsert>;
      article_entities: TableDefinition<
        {
          article_id: string;
          entity_id: string;
          role: string;
          confidence_score: number | null;
          created_at: string;
          updated_at: string;
        },
        {
          article_id: string;
          entity_id: string;
          role?: string;
          confidence_score?: number | null;
          created_at?: string;
          updated_at?: string;
        }
      >;
      activity_history: TableDefinition<
        {
          id: string;
          region_id: string;
          category_id: string | null;
          period_start: string;
          period_end: string;
          activity_score: number;
          event_count: number;
          article_count: number;
          calculation_version: string;
          source_run_id: string | null;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          region_id: string;
          category_id?: string | null;
          period_start: string;
          period_end: string;
          activity_score?: number;
          event_count?: number;
          article_count?: number;
          calculation_version?: string;
          source_run_id?: string | null;
          created_at?: string;
          updated_at?: string;
        }
      >;
      agent_runs: TableDefinition<
        {
          id: string;
          run_type: string;
          started_at: string;
          finished_at: string | null;
          status: string;
          dry_run: boolean;
          stats: Json;
          config: Json;
          error_message: string | null;
          provider: "groq" | "cerebras" | "cloudflare_workers_ai" | null;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          run_type: string;
          started_at?: string;
          finished_at?: string | null;
          status?: string;
          dry_run?: boolean;
          stats?: Json;
          config?: Json;
          error_message?: string | null;
          provider?: "groq" | "cerebras" | "cloudflare_workers_ai" | null;
          created_at?: string;
          updated_at?: string;
        }
      >;
      scheduler_runs: TableDefinition<
        {
          id: string;
          trigger_id: string;
          owner_run_id: string;
          invocation_type: string;
          schedule_date_utc: string;
          slot: string;
          scheduling_timezone: string;
          scheduled_at: string;
          request_date_utc: string;
          acquired_at: string;
          expires_at: string;
          released_at: string | null;
          finished_at: string | null;
          lease_status: string;
          run_status: string;
          final_decision: string;
          stop_reason: string | null;
          quota_used: number;
          quota_remaining: number;
          max_events_per_run: number;
          automatic_revision: boolean;
          dry_run: boolean;
          publish: boolean;
          previous_owner_run_id: string | null;
          lease_recovery_count: number;
          pipeline_run_id: string | null;
          scheduler_decision: string | null;
          event_attempts: number;
          event_final_states: Json;
          requests_used: number;
          duration_ms: number | null;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          trigger_id: string;
          owner_run_id: string;
          invocation_type?: string;
          schedule_date_utc: string;
          slot: string;
          scheduling_timezone: string;
          scheduled_at: string;
          request_date_utc: string;
          acquired_at: string;
          expires_at: string;
          released_at?: string | null;
          finished_at?: string | null;
          lease_status?: string;
          run_status?: string;
          final_decision?: string;
          stop_reason?: string | null;
          quota_used?: number;
          quota_remaining: number;
          max_events_per_run?: number;
          automatic_revision?: boolean;
          dry_run?: boolean;
          publish?: boolean;
          previous_owner_run_id?: string | null;
          lease_recovery_count?: number;
          pipeline_run_id?: string | null;
          scheduler_decision?: string | null;
          event_attempts?: number;
          event_final_states?: Json;
          requests_used?: number;
          duration_ms?: number | null;
          created_at?: string;
          updated_at?: string;
        }
      >;
      agent_logs: TableDefinition<
        {
          id: number;
          run_id: string;
          agent_name: string;
          step: string;
          level: string;
          message: string;
          payload: Json;
          provider: "groq" | "cerebras" | "cloudflare_workers_ai" | null;
          provider_unit: "requests" | "tokens" | "neurons" | null;
          provider_unit_amount: number | null;
          duration_ms: number | null;
          created_at: string;
          updated_at: string;
        },
        {
          id?: number;
          run_id: string;
          agent_name: string;
          step: string;
          level?: string;
          message: string;
          payload?: Json;
          provider?: "groq" | "cerebras" | "cloudflare_workers_ai" | null;
          provider_unit?: "requests" | "tokens" | "neurons" | null;
          provider_unit_amount?: number | null;
          duration_ms?: number | null;
          created_at?: string;
          updated_at?: string;
        }
      >;
      pipeline_event_attempts: TableDefinition<
        {
          id: string;
          event_key: string;
          pipeline_run_id: string;
          attempt_number: number;
          started_at: string;
          completed_at: string | null;
          final_state: "READY_FOR_PUBLICATION" | "WAITING_FOR_HUMAN_REVIEW" | "REVISION_REQUIRED" | "REJECTED" | "VERIFICATION_INSUFFICIENT" | "TECHNICAL_FAILURE" | "PROVIDER_RATE_LIMIT" | "CANCELLED" | "ABORTED" | null;
          stop_stage: string | null;
          stop_reason: string | null;
          retry_class: "NONE" | "TECHNICAL_FAILURE" | "PROVIDER_RATE_LIMIT" | "REVISION_REQUIRED" | "REJECTED" | "VERIFICATION_INSUFFICIENT" | "CANCELLED";
          counts_toward_retry_limit: boolean;
          next_eligible_at: string | null;
          created_at: string;
          purpose: "NORMAL" | "FACTUAL_REMEDIATION";
          start_stage: string | null;
          remediation_article_id: string | null;
          remediation_raw_item_id: string | null;
          remediation_prior_attempt_id: string | null;
          remediation_reason: string | null;
          authorized_by: string | null;
          authorization_reference: string | null;
          pilot_attempt_number: number | null;
            validation_namespace: string | null;
            continuation: Json | null;
            capacity_resume_snapshot: Json | null;
        },
        {
          id?: string;
          event_key: string;
          pipeline_run_id: string;
          attempt_number: number;
          started_at: string;
          completed_at?: string | null;
          final_state?: "READY_FOR_PUBLICATION" | "REVISION_REQUIRED" | "REJECTED" | "VERIFICATION_INSUFFICIENT" | "TECHNICAL_FAILURE" | "PROVIDER_RATE_LIMIT" | "CANCELLED" | "ABORTED" | null;
          stop_stage?: string | null;
          stop_reason?: string | null;
          retry_class?: "NONE" | "TECHNICAL_FAILURE" | "PROVIDER_RATE_LIMIT" | "REVISION_REQUIRED" | "REJECTED" | "VERIFICATION_INSUFFICIENT" | "CANCELLED";
          counts_toward_retry_limit?: boolean;
          next_eligible_at?: string | null;
          created_at?: string;
          purpose?: "NORMAL" | "FACTUAL_REMEDIATION";
          start_stage?: string | null;
          remediation_article_id?: string | null;
          remediation_raw_item_id?: string | null;
          remediation_prior_attempt_id?: string | null;
          remediation_reason?: string | null;
          authorized_by?: string | null;
          authorization_reference?: string | null;
          pilot_attempt_number?: number | null;
            validation_namespace?: string | null;
            continuation?: Json | null;
            capacity_resume_snapshot?: Json | null;
        }
      >;
    };
    Views: {
      public_published_articles: ViewDefinition<{
        slug: string;
        headline_es: string;
        summary_es: string | null;
        why_it_matters_es: string | null;
        body_es: string | null;
        published_at: string;
        updated_at: string;
        region_code: string | null;
        region_name: string | null;
        region_latitude: number | null;
        region_longitude: number | null;
        categories: Json;
        sources: Json;
        entities: Json;
      }>;
      public_regions: ViewDefinition<{
        code: string;
        name: string;
        latitude: number | null;
        longitude: number | null;
      }>;
      public_categories: ViewDefinition<{
        slug: string;
        name: string;
      }>;
    };
    Functions: {
      claim_supervised_scheduler_invocation_m40: {
        Args: { p_utc_day: string; p_trigger_id: string; p_invocation_id: string; p_owner_id: string; p_now: string; p_lease_ttl_seconds: number };
        Returns: Json;
      };
      heartbeat_supervised_scheduler_lease_m40: {
        Args: { p_invocation_id: string; p_owner_id: string; p_fencing_token: number; p_now: string; p_lease_ttl_seconds: number };
        Returns: boolean;
      };
      finish_supervised_scheduler_invocation_m40: {
        Args: { p_invocation_id: string; p_owner_id: string; p_fencing_token: number; p_status: string; p_outcome_code: string; p_work_mode: string | null; p_attempt_id: string | null; p_current_stage: string | null; p_resume_generation: number | null; p_requests_used: number; p_requests_remaining: number | null; p_duration_ms: number; p_now: string };
        Returns: boolean;
      };
      list_open_supervised_scheduler_attempts_m40: {
        Args: Record<PropertyKey, never>;
        Returns: Json;
      };
      defer_pipeline_event_attempt_scheduler_capacity_m40: {
        Args: { p_attempt_id: string; p_event_key: string; p_pipeline_run_id: string; p_resume_stage: string; p_snapshot: Json; p_provider_request_dispatched: boolean; p_provider_requests_used: number; p_owner_id?: string | null; p_claimed_stage?: string | null };
        Returns: Json;
      };
      defer_pipeline_event_attempt_worker_budget_m40: {
        Args: { p_attempt_id: string; p_event_key: string; p_pipeline_run_id: string; p_resume_stage: string; p_snapshot: Json; p_provider_request_dispatched: boolean; p_provider_requests_used: number; p_owner_id?: string | null; p_claimed_stage?: string | null };
        Returns: Json;
      };
      claim_pipeline_event_attempt_scheduler_resume_m40: {
        Args: { p_attempt_id: string; p_event_key: string; p_pipeline_run_id: string; p_resume_stage: string; p_owner_id: string };
        Returns: boolean;
      };
      release_pipeline_event_attempt_scheduler_resume_m40: {
        Args: { p_attempt_id: string; p_event_key: string; p_pipeline_run_id: string; p_resume_stage: string; p_owner_id: string };
        Returns: boolean;
      };
      get_pipeline_human_review_operator_status: {
        Args: Record<PropertyKey, never>;
        Returns: Json;
      };
      list_pipeline_human_reviews_operator: {
        Args: { p_limit: number };
        Returns: Json;
      };
      get_pipeline_human_review_operator_inspect: {
        Args: { p_review_id: string };
        Returns: Json;
      };
      bind_pipeline_human_review_revision: {
        Args: {
          p_review_id: string;
          p_expected_original_draft_sha256: string;
          p_original_draft: Json;
          p_original_publication_payload: Json;
          p_corrected_draft: Json;
          p_corrected_publication_payload: Json;
          p_source_lineage: Json;
          p_corrected_revision_sha256: string;
          p_human_revision_proof: Json;
        };
        Returns: Json;
      };
      get_pipeline_human_review_revision: {
        Args: { p_review_id: string };
        Returns: Json;
      };
      decide_pipeline_human_review_revision: {
        Args: {
          p_review_id: string;
          p_approval_target_revision_sha256: string;
          p_reviewer_id: string;
          p_facts_acceptable: boolean;
          p_attribution_acceptable: boolean;
          p_uncertainty_preserved: boolean;
          p_headline_acceptable: boolean;
          p_summary_acceptable: boolean;
          p_no_unsupported_material_claims: boolean;
          p_source_chain_acceptable: boolean;
        };
        Returns: Json;
      };
      defer_pipeline_event_attempt_capacity_m35: {
        Args: {
          p_attempt_id: string;
          p_event_key: string;
          p_pipeline_run_id: string;
          p_resume_stage: string;
          p_snapshot: Json;
          p_provider_request_dispatched: boolean;
          p_provider_requests_used: number;
          p_owner_id?: string | null;
          p_claimed_stage?: string | null;
        };
        Returns: Json;
      };
      claim_pipeline_event_attempt_capacity_resume_m35: {
        Args: { p_attempt_id: string; p_event_key: string; p_pipeline_run_id: string; p_resume_stage: string; p_owner_id: string };
        Returns: boolean;
      };
      release_pipeline_event_attempt_capacity_resume_m35: {
        Args: { p_attempt_id: string; p_event_key: string; p_pipeline_run_id: string; p_resume_stage: string; p_owner_id: string };
        Returns: boolean;
      };
      reserve_groq_request_and_tokens: {
        Args: {
          p_run_id: string;
          p_agent_name: string;
          p_agent_version: string;
          p_event_key: string | null;
          p_attempt: number;
          p_model: string;
          p_request_date: string;
          p_request_hard_limit: number;
          p_request_soft_limit: number;
          p_token_hard_limit: number;
          p_token_soft_limit: number;
          p_estimated_tokens: number;
        };
        Returns: Json;
      };
      reserve_groq_request_and_tokens_m35: {
        Args: {
          p_run_id: string;
          p_agent_name: string;
          p_agent_version: string;
          p_event_key: string | null;
          p_attempt: number;
          p_model: string;
          p_request_date: string;
          p_request_hard_limit: number;
          p_request_soft_limit: number;
          p_token_hard_limit: number;
          p_token_soft_limit: number;
          p_token_minute_hard_limit: number;
          p_safety_margin_tokens: number;
          p_estimated_tokens: number;
        };
        Returns: Json;
      };
      settle_groq_token_usage: {
        Args: {
          p_reservation_id: number;
          p_run_id: string;
          p_request_date: string;
          p_actual_input_tokens: number;
          p_actual_output_tokens: number;
        };
        Returns: Json;
      };
      reserve_provider_agent_request: {
        Args: {
          p_run_id: string;
          p_agent_name: string;
          p_agent_version: string;
          p_event_key: string | null;
          p_attempt: number;
          p_model: string;
          p_request_date: string;
          p_limit: number;
          p_provider: "groq" | "cerebras" | "cloudflare_workers_ai";
        };
        Returns: Json;
      };
      reserve_cloudflare_neuron_capacity: {
        Args: {
          p_run_id: string;
          p_agent_name: string;
          p_agent_version: string;
          p_event_key: string | null;
          p_attempt: number;
          p_model: string;
          p_request_date: string;
          p_request_limit: number | null;
          p_daily_neuron_allocation: number;
          p_estimated_neurons: number;
        };
        Returns: Json;
      };
      reserve_cloudflare_supervised_critic_validation_capacity: {
        Args: {
          p_run_id: string;
          p_agent_name: string;
          p_agent_version: string;
          p_event_key: string;
          p_attempt: number;
          p_validation_purpose: "critic_stage_validation";
          p_model: string;
          p_request_date: string;
          p_request_limit: number | null;
          p_daily_neuron_allocation: number;
          p_estimated_neurons: number;
        };
        Returns: Json;
      };
      reserve_cloudflare_supervised_stage_validation_capacity: {
        Args: {
          p_run_id: string;
          p_stage: "verifier" | "translator" | "editor" | "classifier" | "ranker" | "critic";
          p_agent_name: string;
          p_agent_version: string;
          p_event_key: string;
          p_fixture: string;
          p_attempt: number;
          p_validation_purpose: string;
          p_provider: "cloudflare_workers_ai";
          p_model: string;
          p_request_date: string;
          p_request_limit: number | null;
          p_daily_neuron_allocation: number;
          p_estimated_neurons: number;
        };
        Returns: Json;
      };
      reserve_cloudflare_quality_benchmark_capacity: {
        Args: {
          p_run_id: string;
          p_stage: "verifier" | "translator" | "editor" | "classifier" | "ranker" | "critic";
          p_benchmark_case_id: string;
          p_agent_name: string;
          p_agent_version: string;
          p_event_key: string;
          p_attempt: number;
          p_validation_purpose: "quality_benchmark";
          p_provider: "cloudflare_workers_ai";
          p_model: string;
          p_request_date: string;
          p_request_limit: number | null;
          p_daily_neuron_allocation: number;
          p_estimated_neurons: number;
        };
        Returns: Json;
      };
      reserve_agent_request: {
        Args: {
          p_run_id: string;
          p_agent_name: string;
          p_agent_version: string;
          p_event_key: string | null;
          p_attempt: number;
          p_model: string;
          p_request_date: string;
          p_limit: number;
        };
        Returns: Json;
      };
      mark_agent_request_dispatched: {
        Args: {
          p_reservation_id: number;
          p_run_id: string;
          p_request_date: string;
        };
        Returns: boolean;
      };
      release_agent_request: {
        Args: {
          p_reservation_id: number;
          p_run_id: string;
          p_request_date: string;
        };
        Returns: boolean;
      };
      publish_article_atomic: {
        Args: {
          p_payload: Json;
        };
        Returns: Json;
      };
      create_pipeline_human_review: {
        Args: {
          p_event_key: string;
          p_attempt_id: string;
          p_pipeline_run_id: string;
          p_draft_id: string;
          p_draft_sha256: string;
          p_source_lineage: Json;
          p_review_manifest: Json;
          p_publication_payload: Json;
        };
        Returns: Json;
      };
      decide_pipeline_human_review: {
        Args: {
          p_review_id: string;
          p_decision: string;
          p_reviewer_id: string;
          p_facts_acceptable: boolean;
          p_attribution_acceptable: boolean;
          p_uncertainty_preserved: boolean;
          p_headline_acceptable: boolean;
          p_summary_acceptable: boolean;
          p_no_unsupported_material_claims: boolean;
          p_source_chain_acceptable: boolean;
        };
        Returns: Json;
      };
      publish_reviewed_article_atomic: {
        Args: {
          p_review_id: string;
          p_event_key: string;
          p_attempt_id: string;
          p_pipeline_run_id: string;
          p_draft_id: string;
          p_draft_sha256: string;
          p_checkpoint_hashes: Json;
          p_source_lineage: Json;
          p_publication_payload: Json;
        };
        Returns: Json;
      };
      acquire_scheduler_run: {
        Args: {
          p_trigger_id: string;
          p_owner_run_id: string;
          p_invocation_type: string;
          p_schedule_date_utc: string;
          p_slot: string;
          p_scheduling_timezone: string;
          p_scheduled_at: string;
          p_request_date_utc: string;
          p_now: string;
          p_expires_at: string;
          p_quota_used: number;
          p_quota_remaining: number;
          p_max_events_per_run: number;
          p_automatic_revision: boolean;
          p_dry_run: boolean;
          p_publish: boolean;
        };
        Returns: Json;
      };
      finish_scheduler_run: {
        Args: {
          p_trigger_id: string;
          p_owner_run_id: string;
          p_run_status: string;
          p_final_decision: string;
          p_stop_reason: string | null;
          p_quota_used: number;
          p_quota_remaining: number;
          p_finished_at: string;
        };
        Returns: boolean;
      };
      release_scheduler_lease: {
        Args: {
          p_trigger_id: string;
          p_owner_run_id: string;
          p_released_at: string;
        };
        Returns: boolean;
      };
      finish_scheduler_run_execution: {
        Args: {
          p_trigger_id: string;
          p_owner_run_id: string;
          p_run_status: string;
          p_final_decision: string;
          p_scheduler_decision: string;
          p_stop_reason: string | null;
          p_pipeline_run_id: string | null;
          p_event_attempts: number;
          p_event_final_states: Json;
          p_requests_used: number;
          p_quota_used: number;
          p_quota_remaining: number;
          p_duration_ms: number;
          p_finished_at: string;
        };
        Returns: boolean;
      };
      claim_pipeline_event_attempt: {
        Args: {
          p_event_key: string;
          p_pipeline_run_id: string;
          p_started_at: string;
          p_now: string;
          p_stale_after_seconds: number;
        };
        Returns: Json;
      };
      claim_incident_factual_remediation_attempt: {
        Args: {
          p_pipeline_run_id: string;
          p_authorized_by: string;
          p_authorization_reference: string;
          p_reason: string;
        };
        Returns: Json;
      };
      authorize_incident_factual_remediation_continuation: {
        Args: {
          p_attempt_id: string;
          p_pipeline_run_id: string;
          p_authorized_by: string;
          p_authorization_reference: string;
          p_reason: string;
          p_checkpoint_manifest: Json;
        };
        Returns: Json;
      };
      resume_incident_factual_remediation_continuation: {
        Args: {
          p_attempt_id: string;
          p_pipeline_run_id: string;
          p_resume_execution_id: string;
          p_checkpoint_manifest: Json;
        };
        Returns: Json;
      };
      finish_incident_factual_remediation_continuation: {
        Args: {
          p_attempt_id: string;
          p_pipeline_run_id: string;
          p_critic_decision: string | null;
          p_stop_stage: string;
          p_stop_reason: string;
          p_provider_requests_used: number;
        };
        Returns: Json;
      };
      publish_incident_factual_remediation_continuation_atomic: {
        Args: {
          p_attempt_id: string;
          p_pipeline_run_id: string;
          p_article_id: string;
          p_expected_slug: string;
          p_payload: Json;
        };
        Returns: Json;
      };
      claim_factual_remediation_attempt: {
        Args: {
          p_pipeline_run_id: string;
          p_authorized_by: string;
          p_authorization_reference: string;
          p_reason: string;
          p_event_key: string;
          p_event_id: string;
          p_article_id: string;
          p_raw_item_id: string;
          p_prior_attempt_id: string;
          p_purpose: string;
          p_start_stage: string;
          p_validation_namespace: string | null;
        };
        Returns: Json;
      };
      publish_factual_remediation_article_atomic: {
        Args: {
          p_attempt_id: string;
          p_pipeline_run_id: string;
          p_article_id: string;
          p_expected_slug: string;
          p_payload: Json;
        };
        Returns: Json;
      };
      finalize_pipeline_event_attempt: {
        Args: {
          p_attempt_id: string;
          p_pipeline_run_id: string;
          p_completed_at: string;
          p_final_state: string;
          p_stop_stage: string | null;
          p_stop_reason: string | null;
          p_retry_class: string;
          p_counts_toward_retry_limit: boolean;
          p_next_eligible_at: string | null;
        };
        Returns: Json;
      };
      defer_pipeline_event_attempt_capacity: {
        Args: {
          p_attempt_id: string;
          p_event_key: string;
          p_pipeline_run_id: string;
          p_resume_stage: string;
          p_snapshot: Json;
          p_provider_request_dispatched: boolean;
          p_provider_requests_used: number;
          p_owner_id: string | null;
          p_claimed_stage: string | null;
        };
        Returns: Json;
      };
      claim_pipeline_event_attempt_capacity_resume: {
        Args: {
          p_attempt_id: string;
          p_event_key: string;
          p_pipeline_run_id: string;
          p_resume_stage: string;
          p_owner_id: string;
        };
        Returns: boolean;
      };
      release_pipeline_event_attempt_capacity_resume: {
        Args: {
          p_attempt_id: string;
          p_event_key: string;
          p_pipeline_run_id: string;
          p_resume_stage: string;
          p_owner_id: string;
        };
        Returns: boolean;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

export type Tables<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Row'];

export type TablesInsert<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Insert'];

export type TablesUpdate<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Update'];
