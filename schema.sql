-- ============================================================
-- Ahmed Abdallah Business Development — ERP backend schema
-- Target: Supabase (Postgres + Auth + Row Level Security)
-- Run once in the Supabase SQL editor after creating the project.
-- Gives: real accounts, shared data on every device, per-section
-- permissions enforced BY THE DATABASE (not the browser), and an
-- admin-only inbox for Contact-us messages.
-- ============================================================

-- ---------- Profiles & permissions ----------

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  role text not null check (role in ('admin','employee')),
  created_at timestamptz not null default now()
);

create table if not exists public.section_access (
  user_id uuid not null references public.profiles(id) on delete cascade,
  section text not null,
  primary key (user_id, section)
);

-- Helper: is the current user an admin?
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin') $$;

-- Helper: does the current user have a section?
create or replace function public.has_section(sec text)
returns boolean language sql stable security definer set search_path = public as
$$ select public.is_admin() or exists
     (select 1 from public.section_access where user_id = auth.uid() and section = sec) $$;

alter table public.profiles enable row level security;
alter table public.section_access enable row level security;

create policy profiles_read_own on public.profiles
  for select using (id = auth.uid() or public.is_admin());
create policy profiles_admin_write on public.profiles
  for all using (public.is_admin()) with check (public.is_admin());

create policy access_read_own on public.section_access
  for select using (user_id = auth.uid() or public.is_admin());
create policy access_admin_write on public.section_access
  for all using (public.is_admin()) with check (public.is_admin());

-- ---------- Business tables ----------
-- Every table carries created_by/updated_at for audit; RLS maps each
-- table to the app section that guards it.

create table if not exists public.companies (
  id bigint generated always as identity primary key,
  name text not null, industry text, email text, phone text, website text,
  address text, notes text,
  created_by uuid references auth.users, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.contacts (
  id bigint generated always as identity primary key,
  first_name text not null, last_name text, email text, phone text, position text,
  company_id bigint references public.companies(id) on delete set null,
  status text not null default 'lead', tags text, notes text,
  created_by uuid references auth.users, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.deals (
  id bigint generated always as identity primary key,
  title text not null, value numeric not null default 0,
  stage text not null default 'Lead' check (stage in ('Lead','Qualified','Proposal','Negotiation','Won','Lost')),
  contact_id bigint references public.contacts(id) on delete set null,
  company_id bigint references public.companies(id) on delete set null,
  expected_close date, notes text,
  created_by uuid references auth.users, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.tasks (
  id bigint generated always as identity primary key,
  title text not null, description text, due_date date,
  priority text not null default 'medium', done boolean not null default false,
  contact_id bigint references public.contacts(id) on delete set null,
  deal_id bigint references public.deals(id) on delete set null,
  created_by uuid references auth.users, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.activities (
  id bigint generated always as identity primary key,
  type text not null default 'note', subject text not null, body text,
  contact_id bigint references public.contacts(id) on delete set null,
  deal_id bigint references public.deals(id) on delete set null,
  created_by uuid references auth.users, created_at timestamptz not null default now()
);

create table if not exists public.products (
  id bigint generated always as identity primary key,
  name text not null, sku text, category text,
  price numeric not null default 0, cost numeric not null default 0,
  stock numeric not null default 0, reorder_level numeric not null default 0,
  created_by uuid references auth.users, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.suppliers (
  id bigint generated always as identity primary key,
  name text not null, contact_person text, email text, phone text,
  created_by uuid references auth.users, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.invoices (
  id bigint generated always as identity primary key,
  number text not null, contact_id bigint references public.contacts(id) on delete set null,
  issue_date date not null default current_date,
  status text not null default 'draft' check (status in ('draft','sent','paid')),
  tax_rate numeric not null default 0,
  items jsonb not null default '[]',
  created_by uuid references auth.users, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.purchases (
  id bigint generated always as identity primary key,
  number text not null, supplier_id bigint references public.suppliers(id) on delete set null,
  order_date date not null default current_date,
  status text not null default 'ordered' check (status in ('ordered','received')),
  items jsonb not null default '[]',
  created_by uuid references auth.users, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.ledger (
  id bigint generated always as identity primary key,
  date date not null default current_date,
  type text not null check (type in ('income','expense')),
  category text not null, amount numeric not null, memo text,
  ref_type text, ref_id bigint,
  created_by uuid references auth.users, created_at timestamptz not null default now()
);

create table if not exists public.employees (
  id bigint generated always as identity primary key,
  name text not null, department text, salary numeric not null default 0,
  hire_date date, status text not null default 'active',
  created_by uuid references auth.users, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.notes (
  id bigint generated always as identity primary key,
  title text not null, body text, pinned boolean not null default false,
  created_by uuid references auth.users, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

-- Contact-us messages: anyone signed in can write; only the admin reads.
create table if not exists public.messages (
  id bigint generated always as identity primary key,
  name text not null, subject text not null, body text not null,
  read boolean not null default false,
  created_by uuid references auth.users, created_at timestamptz not null default now()
);

-- ---------- RLS per section ----------

do $$
declare t text; sec text;
begin
  for t, sec in select * from (values
    ('companies','companies'), ('contacts','contacts'), ('deals','deals'),
    ('tasks','tasks'), ('activities','contacts'), ('products','products'),
    ('suppliers','suppliers'), ('invoices','invoices'), ('purchases','purchases'),
    ('ledger','finance'), ('employees','employees'), ('notes','notes')
  ) as x(t, sec)
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I_read  on public.%I for select using (public.has_section(%L))', t||'_read', t, sec);
    execute format('create policy %I_write on public.%I for all    using (public.has_section(%L)) with check (public.has_section(%L))', t||'_write', t, sec, sec);
  end loop;
end $$;

alter table public.messages enable row level security;
create policy messages_insert on public.messages
  for insert with check (auth.uid() is not null);
create policy messages_admin_read on public.messages
  for select using (public.is_admin());
create policy messages_admin_update on public.messages
  for update using (public.is_admin()) with check (public.is_admin());
create policy messages_admin_delete on public.messages
  for delete using (public.is_admin());
