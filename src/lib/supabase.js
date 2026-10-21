import { createClient } from '@supabase/supabase-js'

const supabaseUrl  = import.meta.env.VITE_SUPABASE_URL
const supabaseAnon = import.meta.env.VITE_SUPABASE_ANON_KEY

// Don't throw at import time: that blanks the whole page with no explanation.
// App.jsx shows `configError` instead.
export const configError = (!supabaseUrl || !supabaseAnon)
  ? 'Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. Locally, copy .env.example to .env.local; on Vercel, add them under Project Settings → Environment Variables and redeploy.'
  : null

export const supabase = createClient(
  supabaseUrl  || 'http://localhost:54321',
  supabaseAnon || 'missing-anon-key',
  { realtime: { params: { eventsPerSecond: 10 } } },
)
