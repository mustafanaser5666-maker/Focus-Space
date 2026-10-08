import { createClient } from '@supabase/supabase-js'

const url = 'https://zifkgtfwmzpsphdstsew.supabase.co'
const key = 'sb_publishable_dEsAFjxuNye6zKPm657pxQ_kNtdsFIi'

export const supabase = createClient(url, key)
