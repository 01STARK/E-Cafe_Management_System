# The Site Gaming Cafe — Developer Guide

---

## 1. Local Debugging

### Prerequisites
- Node.js v20 LTS installed at `D:\08-Softwares\Nodejs`
- PowerShell

### Steps

**1. Open PowerShell and add Node to PATH**
```powershell
$env:PATH += ";D:\08-Softwares\Nodejs"
```

**2. Navigate to the project**
```powershell
cd "D:\04-Skill Grind\Projects\gaming-cafe"
```

**3. Install dependencies (first time or after pulling changes)**
```powershell
npm install
```

**4. Start the server**
```powershell
node server.js
```

**5. Open the app**
```
http://localhost:3000
```

**6. If port 3000 is already in use**
```powershell
Get-Process -Id (Get-NetTCPConnection -LocalPort 3000).OwningProcess | Stop-Process -Force
node server.js
```

### Tips
- All logs print directly in the PowerShell terminal
- The local database is at `db/cafe.db` — separate from the live Fly.io database
- Changes to HTML/CSS/JS are instant on refresh (no restart needed)
- Changes to `server.js` or `db/database.js` require a server restart

---

## 2. Deploying Updates to Fly.io

### Prerequisites
- flyctl installed at `C:\Users\smitt\.fly\bin\flyctl.exe`

### Steps

**1. Add flyctl to PATH**
```powershell
$env:PATH += ";$env:USERPROFILE\.fly\bin"
```

**2. Login (if not already logged in)**
```powershell
fly auth login
```

**3. Navigate to the project**
```powershell
cd "D:\04-Skill Grind\Projects\gaming-cafe"
```

**4. Deploy**
```powershell
fly deploy
```
This builds a new Docker image and rolls it out. Takes 2–3 minutes.

**5. Verify the deployment**
```powershell
fly status
```

**6. Watch live logs**
```powershell
fly logs
```

### What gets deployed
- All changes to `server.js`, `public/`, `db/database.js`, `fly.toml`
- The `.env` file is NOT deployed — secrets are set separately via `fly secrets set`

### Setting / updating secrets
```powershell
fly secrets set KEY=value
```
Example:
```powershell
fly secrets set EMAIL_PASS=yournewapppassword
```

---

## 3. Rolling Back a Deployment

### View release history
```powershell
fly releases
```
This lists all deployments with version numbers (v1, v2, v3...).

### Rollback to a previous version
```powershell
fly deploy --image registry.fly.io/the-site-gaming-cafe:<version>
```
Example — rollback to v3:
```powershell
fly deploy --image registry.fly.io/the-site-gaming-cafe:deployment-01ABCDEF
```
Get the exact image ID from `fly releases`.

### Quick rollback (one command)
```powershell
fly releases --json | ConvertFrom-Json | Select-Object -Index 1 | ForEach-Object { fly deploy --image $_.ImageRef }
```
This redeploys the version just before the current one.

---

## 4. Useful Fly.io Commands

| Command | What it does |
|---|---|
| `fly status` | Show app and machine status |
| `fly logs` | Stream live server logs |
| `fly releases` | List all deployments |
| `fly deploy` | Deploy latest code |
| `fly secrets list` | Show configured secrets (values hidden) |
| `fly secrets set KEY=val` | Add or update a secret |
| `fly ssh console` | SSH into the running container |
| `fly open` | Open the live app in browser |

---

## 5. Live App

```
https://the-site-gaming-cafe.fly.dev
```

Login credentials:
- **Username:** STARK
- **Password:** 001@Focus
