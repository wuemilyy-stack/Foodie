# FoodiePass

One $30 yearly pass for offers at independent restaurants across Houston. Restaurants join free.

| Path | What it is |
|---|---|
| `foodiepass-website.html` | The website (single file: finder map, join, My pass, partner sign-up, accounts and billing UI) |
| `tools/build_site.py` | Escapes non-ASCII and builds `netlify-deploy/index.html` + `foodiepass-netlify.zip` |
| `netlify-deploy/_headers` | Security headers for the Netlify deploy |
| `foodiepass-backend/` | Supabase database migration, Edge Functions (Stripe Checkout, portal, webhook, status, gifts, account deletion) and tests. See its README for setup |
| `login-and-payments-spec.md` | The accounts and payments spec the backend implements |

## Build the deployable site

```bash
python3 tools/build_site.py
```

Then drag `foodiepass-netlify.zip` (or the `netlify-deploy` folder) into Netlify.

## Run the backend tests

```bash
cd foodiepass-backend
node --experimental-strip-types --test tests/entitlements.test.ts
```

## Keys

The website contains only the Supabase project URL and the **publishable** key. Both are designed to be public, and Row Level Security protects the data. The service-role key and all Stripe secrets live only in Supabase function secrets. Never commit them.
