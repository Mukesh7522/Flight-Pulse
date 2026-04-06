import { createClient } from '@supabase/supabase-js'

const supabaseUrl  = import.meta.env.VITE_SUPABASE_URL
const supabaseAnon = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnon) {
  throw new Error(
    'Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY in .env.local\n' +
    'Copy .env.example → .env.local and fill in your Supabase project credentials.'
  )
}

export const supabase = createClient(supabaseUrl, supabaseAnon, {
  realtime: {
    params: { eventsPerSecond: 10 },
  },
})
