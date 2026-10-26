# FleetTrack

Vehicle trip recording and live fleet tracking.

- **Drivers** use their phone (Android or iPhone). They sign in, choose a vehicle and press **Start trip**. GPS is recorded until they press **End trip**.
- **Control room** (computer or phone) sees every vehicle on a live map with its trip history, route playback, overspeed alerts, CSV reports and an audit log.

This is **Stage 1**: the server, database, control dashboard and the driver app (installable from the browser, no app store needed). See [Roadmap](#roadmap) for what comes next.

---

## 1. Run it on your Windows PC

You need Python 3.12 or newer (`py --version` to check).

```powershell
cd C:\Users\Pankaj\Desktop\TrackingSys
py -3.13 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env
```

Open `.env` in Notepad and set:

- `SECRET_KEY`: paste the output of `python -c "import secrets; print(secrets.token_urlsafe(48))"`
- `ADMIN_PASSWORD`: the first control-room password (at least 8 characters, letters and numbers)

Start the server:

```powershell
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Open <http://127.0.0.1:8000> and sign in as `admin` with your `ADMIN_PASSWORD`.

**Watch a demo.** While the server is running, open a second PowerShell window in the same folder, activate the venv and run:

```powershell
python scripts\simulate.py --password <your ADMIN_PASSWORD>
```

Four demo vehicles drive around New Delhi for 10 minutes; one of them overspeeds. Use this on your PC only, never on the real server.

**Run the tests:**

```powershell
pip install -r requirements-dev.txt
pytest
```

---

## 2. Put it online for free (Render + Neon)

Phones can only reach the server if it is on the internet with HTTPS. This setup costs ₹0:

| Part | Service | Free limit |
|---|---|---|
| Web server | [Render](https://render.com) free web service | Sleeps after 15 min without traffic; wakes in about 1 minute |
| Database | [Neon](https://neon.tech) free PostgreSQL | 0.5 GB, about 2.5 million GPS points (roughly 3,500 hours of driving) |

Your data lives in Neon, so it survives Render restarts and redeploys.

### Step 1: Put the code on GitHub
1. Create a free account at <https://github.com> and a new **private** repository named `fleettrack`.
2. Upload this folder to it **without** `.env`, `.venv` or `fleettrack.db`. The `.gitignore` file already excludes them if you use git.

### Step 2: Create the database (Neon)
1. Sign up at <https://neon.tech> and create a project. Choose the region **Asia Pacific (Singapore)**, the closest to India.
2. Copy the **connection string**. It looks like `postgresql://user:password@ep-xxxx.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`.

### Step 3: Create the web server (Render)
1. Sign up at <https://render.com> with your GitHub account.
2. Click **New → Blueprint** and pick your `fleettrack` repository. Render reads `render.yaml`.
3. When it asks, fill in:
   - `DATABASE_URL`: the Neon connection string
   - `ADMIN_PASSWORD`: a strong password for the first control-room account
4. Click **Apply**. After a few minutes you get an address like `https://fleettrack-xxxx.onrender.com`.

### Step 4: Set up your fleet
1. Open the address and sign in as `admin`.
2. Go to **People → Add person** for each driver. FleetTrack shows a username and starting password to give them privately.
3. Go to **Vehicles → Add vehicle** for each vehicle and set its speed limit.

---

## 3. Install the app on phones

**Android (Chrome):** open the address → sign in → tap **Install app** (or ⋮ → **Add to Home screen**). When asked, allow **Location** and choose **Precise**.

**iPhone (Safari):** open the address → tap **Share** → **Add to Home Screen**. Open FleetTrack from the home screen, and when asked allow **Location: While Using the App** with **Precise Location** on.

The same app serves both roles: drivers get the driver screen, and control-room accounts get the dashboard.

---

## Important limits of Stage 1

- **Keep the screen on during a trip.** Browsers stop GPS when the phone is locked or the app is in the background, on both Android and iPhone. The driver app keeps the screen awake and warns about gaps, but true background tracking needs the native app (Stage 3). Until then, use a phone holder and a charger.
- **Free server wake-up.** If nobody has used the server for 15 minutes, the first sign-in takes up to a minute. Once trips are running, the phones keep it awake. Points recorded while it wakes up are saved on the phone and uploaded automatically.
- **No signal.** Points are stored on the phone (up to about 55 hours) and uploaded when signal returns. On the map the vehicle shows **Signal lost** after 2 minutes and **Offline** after 10, never a fake live position.
- **Overspeed** uses the phone's GPS speed and alerts above the limit + 5 km/h. Only readings with good accuracy (±30 m or better) count. Treat it as a strong indication, not legal proof.
- **Map tiles** come from OpenStreetMap's free public servers. That is fine for a small fleet; a large fleet should use a paid tile provider.
- **Official data.** Before you put real Army vehicle movements on any outside cloud service, get approval from your unit's IT / information-security authority. FleetTrack can also run on a server you own: use the `Dockerfile` with any PostgreSQL database.

## Security already built in

- Each person has their own account, and a new password is required at first sign-in. Passwords are stored as PBKDF2 hashes.
- Drivers can only see and change their own trips. Only control-room accounts see the map, reports and other people.
- Repeated wrong passwords lock that username for 15 minutes.
- Resetting a password or disabling an account signs that person out on every phone.
- Every sign-in, change, trip start/end, forced trip end, alert acknowledgement and export goes in the **Audit log**.
- HTTPS (on Render) plus strict security headers (Content Security Policy, no framing, HSTS).
- The database enforces one running trip per vehicle and per driver.

## Roadmap

| Stage | What | Status |
|---|---|---|
| 1 | Server, database, control dashboard, driver web app, offline queue | ✅ This version |
| 2 | Hardening: database migrations, automated daily backups, uptime and missed-update alerts (SMS/WhatsApp/email), geofences (depots, restricted areas) | Next |
| 3 | Native Android + iPhone driver app (same screens, wrapped with Capacitor) with real background GPS, so tracking continues with the screen locked | Planned |
| 4 | Move to a paid or self-hosted server when the fleet relies on it daily | When needed |

## Project layout

```
app/            Python server (FastAPI)
  main.py       start-up, pages, security headers
  models.py     database tables
  tracking.py   distance, speed, overspeed and live-status rules
  routers/      API: auth, admin (people/vehicles/audit), trips
static/         web app: sign-in, driver app, control dashboard, icons
scripts/        simulate.py demo
tests/          automated tests
Dockerfile, render.yaml   deployment
```

API reference (on your PC only): <http://127.0.0.1:8000/api/docs>
