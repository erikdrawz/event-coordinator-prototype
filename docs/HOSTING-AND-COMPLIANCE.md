# Event Center: hosting and compliance path

Status: v0.1 (9 Nov 2026). Companion to [ARCHITECTURE.md](ARCHITECTURE.md).

**In short:**
- Pharma security teams rarely reject an app because of its database brand. They reject vendors that can't pass their security assessment.
- What matters most is whether **Brightside itself** is certified, where the data lives, and who touches it.
- Supabase isn't disqualifying, but **AWS is the target** for production customers.
- The architecture makes the move cheap, provided Code keeps the guardrails at the end of this doc.

## What a pharma vendor assessment checks

- **Brightside's own certification:** SOC 2 Type II or ISO 27001 for Brightside, not just for its providers.
  - This is the long pole: a Type II report needs an observation period of several months.
  - Compliance automation tools (e.g. Vanta, Drata) make it manageable.
- **Data protection:**
  - a GDPR data processing agreement (DPA)
  - EU data residency for EU customers
  - a list of sub-processors
  - HCP personal data and transfer-of-value figures will get the most questions
- **Security controls:**
  - SSO with the customer's identity provider (Entra ID, Okta)
  - encryption at rest and in transit
  - backups and disaster recovery targets (RPO/RTO)
  - penetration test results
  - incident response
  - access reviews
  - an audit trail
- **GxP:** usually out of scope for events. Expect questions on how changes are validated. Test-to-production configuration packages ([AI-APPROACH.md](AI-APPROACH.md), section 4) are a good answer.

## Where Supabase stands

- **Credentials:** Supabase runs on AWS and holds SOC 2 Type II and ISO 27001. It offers HIPAA business associate agreements and EU regions, and a project's database, auth and storage stay in the chosen region.
- **Plans:** the reports, certificate and agreements come with the **Team and Enterprise** plans, not the free tier.
- **Good enough for a pilot** with a friendly customer, if their assessment allows it.

The friction is procurement, not technology:
- **It's an extra sub-processor layer** between the customer and AWS, which means more questionnaire answers.
- **It's a younger vendor than the hyperscalers,** which feeds vendor-risk concerns.
- **Large customers may want a dedicated instance** in their own region, or even their own cloud account.

## Target: AWS (Azure as the alternative)

**AWS is the default:**
- it's the team's experience
- Veeva Vault runs on AWS, so pharma security teams know it
- most pharma companies already have AWS agreements

**Azure is the serious alternative.**
- Many pharma companies are Microsoft shops (Entra ID, Teams). That matters for the Teams integration idea too.
- Choose AWS unless the first real customer pushes for Azure.
- The design is Postgres-based, so either works.

### How the current stack maps to AWS

| Today | On AWS |
|---|---|
| Supabase Postgres (security rules, functions, triggers) | Amazon RDS or Aurora PostgreSQL, unchanged |
| PostgREST (the API) | the same open-source PostgREST, in containers on ECS Fargate |
| Supabase Auth | the customer's identity provider (Entra ID, Okta) via Amazon Cognito, or directly |
| Supabase Storage + its access policies | S3 with signed links issued by a small service. **The least portable piece today** |
| Email queue (`email_message`) | the same tables, sent by Amazon SES |
| Static UI (Vite build) | S3 + CloudFront |
| GitHub Actions + Supabase CLI | infrastructure as code (Terraform or CDK), one stack per environment, migrations run by CI |
| Secrets in GitHub | AWS Secrets Manager + KMS |

### Tenancy

Pharma enterprises often prefer **a dedicated database per customer** over a shared one. The `tenant_id` design supports both:
- a shared stack for smaller customers
- a dedicated database, in the customer's chosen region, for large ones

No rewrite either way.

## When to move

- **Not now.** Stay on Supabase through demos and a first pilot.
- **Move before the first customer puts real HCP data in.**
- **Start Brightside's SOC 2 (or ISO 27001) work at the same time.** Both take months, so start them in parallel once a pilot looks likely.

## Guardrails for Code (keep the move cheap)

1. **Auth stays isolated.** `auth.uid()` appears only inside `app.current_user_id()` and the auth adapter migration. In the UI, only `apps/web/src/lib/auth.tsx` touches the identity provider.
2. **File access goes through database functions** that hand out file paths and links. Supabase's storage access policies (`storage.objects`) don't port to S3. Keep that logic small and in one place, so moving means swapping one service.
3. **No Supabase-only features:**
   - no Realtime
   - no Edge-only business logic
   - no extensions RDS doesn't support, e.g. `pgsodium` / Supabase Vault (`pg_cron` and `pgvector` are fine)
4. **Everything stays plain SQL migrations plus PostgREST,** as now. The roles the API uses (`anon`, `authenticated`) are ordinary Postgres roles and can be recreated on RDS.
5. **Integrations get a real interface with a mock behind it:** CRM, CLM, email sending, invoice reading. Swapping the mock for a real service shouldn't touch the schema.

## Sources

- [Supabase Security](https://www.supabase.com/security)
- [Supabase is now ISO 27001 certified](https://supabase.com/blog/supabase-is-now-iso-27001-certified)
- [Supabase is now HIPAA and SOC2 Type 2 compliant](https://supabase.com/blog/supabase-soc2-hipaa)
