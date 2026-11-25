# Backend plan — real accounts, shared data, real security
# خطة الخادم — حسابات حقيقية وبيانات مشتركة وحماية فعلية

## What this adds (الذي سيضاف)

Today the ERP runs fully in the browser: fast and free, but the sign-in gate
lives on each device and every browser keeps its own copy of the data.

This plan moves accounts and data to a managed backend (**Supabase**) so that:

- كل موظف يدخل بحسابه من أي جهاز، والبيانات واحدة ومشتركة لحظيًا.
- الصلاحيات تتفرض من قاعدة البيانات نفسها (Row Level Security)، مش من الواجهة —
  حتى لو حد فتح أدوات المطور مش هيقدر يقرأ أو يعدّل قسم مش مسموح له.
- رسائل «تواصل معنا» توصل لمدير النظام على أي جهاز، مش بس نفس المتصفح.
- نسخ احتياطي تلقائي من المنصة بدل ما البيانات تضيع مع مسح المتصفح.

## Architecture

```
Browser (this same app, on GitHub Pages — stays free)
   │  supabase-js (auth + data, over HTTPS)
   ▼
Supabase project (one project is enough)
   ├── Auth        email+password accounts (admin invites employees)
   ├── Postgres    the 14 tables in schema.sql
   └── RLS         per-section access enforced in the database itself
```

- The front end barely changes: the localStorage `store` becomes a
  Supabase-backed store with an offline cache, so the app keeps working
  with poor connectivity and syncs when back.
- `schema.sql` in this repo is ready to run: tables, permission helpers
  (`is_admin`, `has_section`), and a policy per section. `messages` allows
  any signed-in user to insert but only the admin to read/update/delete.
- Employee accounts are created by the admin from inside the app through a
  small Supabase Edge Function (`create-user`, holds the service key
  server-side; the browser never sees it). Sketch included below.
- Audit: every row carries `created_by` + timestamps.

## Cost (verified today on supabase.com)

| Item | Free plan | When paid |
| --- | --- | --- |
| Price | $0 | Pro $25/month only if we outgrow free |
| Database | 500 MB | plenty for this ERP (thousands of rows ≈ a few MB) |
| Projects | 2 active | we need 1 |
| API requests | unlimited | — |
| Pausing | project pauses after 7 days of no activity; one click restores it | Pro removes pausing |
| Sources | supabase.com/pricing, supabase.com/docs/guides/platform/free-project-pausing | |

Google Drive export stays client-side and free; it needs a one-time OAuth
client setup in Google Cloud (see README).

## Deployment steps (30–45 minutes, one time)

1. Create the Supabase account — **owner decision: Ahmed's email**. Sign-in
   with GitHub or Google works; the project belongs to his account.
2. New project → region closest to Egypt (e.g. Central EU) → free plan.
3. SQL editor → run `schema.sql` (creates tables + policies).
4. Authentication → enable email provider; the first admin signs up from the
   app, then gets promoted to `admin` once in the `profiles` table.
5. Add the project URL + anon key to the app (Settings → backend). The anon
   key is safe to expose: RLS is what enforces access.
6. Deploy the `create-user` edge function for admin-managed employee accounts.
7. Migrate existing browser data with the app's JSON export → import script.

## Edge function sketch (create-user)

```ts
// supabase/functions/create-user/index.ts — runs server-side, holds service key
import { createClient } from 'jsr:@supabase/supabase-js@2';
Deno.serve(async (req) => {
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const caller = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: req.headers.get('Authorization')! } } });
  const { data: me } = await caller.auth.getUser();
  const { data: prof } = await admin.from('profiles').select('role').eq('id', me.user?.id).single();
  if (prof?.role !== 'admin') return new Response('forbidden', { status: 403 });
  const { email, password, username, role, sections } = await req.json();
  const { data: u, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) return new Response(error.message, { status: 400 });
  await admin.from('profiles').insert({ id: u.user.id, username, role });
  await admin.from('section_access').insert((sections || []).map((s: string) => ({ user_id: u.user.id, section: s })));
  return Response.json({ id: u.user.id });
});
```

## Decisions needed from the owner (قرارات مطلوبة)

1. **الموافقة على إنشاء حساب Supabase بإيميله** (مجاني) — الحساب هيكون ملكه.
2. **الموافقة على إعداد Google OAuth Client** في حساب Google الخاص به عشان
   يتفعّل زرار التصدير إلى Drive (مجاني برضه).
3. بعد ما الخادم يشتغل: نقل البيانات الحالية من المتصفح للنسخة المشتركة.
