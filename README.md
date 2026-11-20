# Delivery Tracker

Tracks each delivery's **client commitment date** against its **production** and **shipment** dates, with logins, admin user control and automatic alerts.

- **Frontend:** static HTML/CSS/JS (`index.html`, `css/`, `js/`) hosted on Vercel. No build step.
- **Backend:** Supabase (`delivery-tracker` project, Singapore region) for auth, the Postgres database, row-level security, alerts and the admin edge function.

## What it does

| Page | Purpose |
|---|---|
| Dashboard | Open / on track / tight / at risk / overdue counts, on-time rate, average production vs shipment vs commitment window, upcoming commitments by week |
| Deliveries | Filterable, sortable list, a create/edit drawer, change history, quick "done today" buttons, CSV import/export |
| Timeline | Gantt view: production bar, shipment bar and the client commitment marker per delivery |
| Alerts | Open / dismissed / resolved alerts; dismissals are per user; live toast for new critical alerts |
| Users (admin) | Add users, approve access requests, change roles, deactivate, set passwords, delete |
| Alert settings (admin) | Due-soon window, minimum buffer, default transit days |

### Key calculations (`delivery_metrics` view)
- **Forecast delivery** = delivered date → ETA → actual ship + default transit → planned ship + default transit (first one available)
- **Buffer days** = commitment date − forecast delivery (negative = late)
- **Production variance** = actual completion − planned completion (positive = late)
- **Shipment variance** = actual ship − planned ship (positive = late)
- **Health**: on track, tight buffer, at risk, overdue, delivered on time, delivered late

### Alerts
`generate_alerts()` runs after every change to deliveries or settings, and nightly at 00:05 SGT (pg_cron). It opens, updates and auto-resolves alerts:
commitment overdue · forecast later than commitment · tight buffer · due soon · production overdue · production after planned shipment · shipment overdue.

### Roles
- **admin**: everything, plus users, settings and deleting deliveries
- **editor**: create and edit deliveries
- **viewer**: read only

The first account ever created becomes the admin. Anyone using "Request access" is inactive until an admin approves them. All access is enforced in the database through row-level security.

## Structure
```
index.html
css/styles.css
js/config.js          Supabase URL + publishable key (safe to be public)
js/app.js             the app
supabase/migrations/  database schema (already applied)
supabase/functions/admin-users/  admin edge function (already deployed)
vercel.json
```

## Run locally
Any static server works, e.g. `npx serve .`, then open http://localhost:3000.
