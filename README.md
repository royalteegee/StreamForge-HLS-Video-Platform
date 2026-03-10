# StreamForge — HLS Video Platform

A full-stack video processing platform where users upload MP4 files that are automatically converted to HLS (HTTP Live Streaming) format using AWS Lambda + FFmpeg. The converted video is served as an adaptive `.m3u8` playlist for smooth in-browser streaming.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              FULL FLOW                                      │
│                                                                             │
│  [React App]                                                                │
│      │                                                                      │
│      │ 1. POST /api/videos/presigned-url  {title}                          │
│      ▼                                                                      │
│  [Express Backend]                                                          │
│      │  Creates Video doc in MongoDB (status: "processing")                │
│      │  Generates S3 presigned PUT URL                                     │
│      │  Returns { videoId, presignedUrl }                                  │
│      │                                                                      │
│      │ 2. Frontend PUTs video file directly to presigned URL               │
│      ▼                                                                      │
│  [S3 Raw Bucket]  ←── file lands here                                      │
│      │                                                                      │
│      │ 3. S3 PUT Event auto-triggers Lambda                                │
│      ▼                                                                      │
│  [Lambda + FFmpeg Layer]                                                    │
│      │  Downloads MP4 from S3                                              │
│      │  Runs FFmpeg: MP4 → HLS (playlist.m3u8 + segment*.ts)              │
│      │  Uploads all HLS files to Processed S3 bucket                      │
│      │  POSTs webhook to backend with playlistUrl                          │
│      │                                                                      │
│      │ 4. POST /api/videos/webhook  {videoId, status, playlistUrl}         │
│      ▼                                                                      │
│  [Express Backend]                                                          │
│      │  Updates MongoDB Video doc: status="ready", playlistUrl=...        │
│      │                                                                      │
│      │ 5. Frontend polls GET /api/videos/:id every 5s                     │
│      ▼                                                                      │
│  [React App]                                                                │
│      │  Detects status="ready"                                             │
│      │  Loads HLS stream via HLS.js                                        │
│      └──► User watches the video ✅                                        │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Project Structure

```
video-hls-platform/
├── frontend/                   # React + Vite app
│   ├── src/
│   │   ├── App.jsx             # Root component + simple page router
│   │   ├── index.css           # Global styles (dark theme, design system)
│   │   ├── main.jsx            # Entry point
│   │   ├── pages/
│   │   │   ├── UploadPage.jsx  # Drag-and-drop upload + live progress steps
│   │   │   ├── LibraryPage.jsx # Video grid with status badges + auto-refresh
│   │   │   └── PlayerPage.jsx  # HLS.js player
│   │   └── utils/
│   │       └── api.js          # All fetch calls + upload flow + polling
│   ├── .env.example
│   ├── index.html
│   ├── package.json
│   └── vite.config.js
│
├── backend/                    # Node.js + Express API
│   ├── app.js                  # Express setup, MongoDB connect, server start
│   ├── models/
│   │   └── Video.js            # Mongoose schema
│   ├── routes/
│   │   └── videos.js           # All video endpoints
│   ├── middleware/
│   │   └── auth.js             # Webhook secret verification
│   ├── .env.example
│   └── package.json
│
└── lambda/                     # AWS Lambda function
    ├── index.js                # Handler: S3 download → FFmpeg → S3 upload → webhook
    ├── .env.example            # Lambda environment variables reference
    └── package.json
```

---

## Prerequisites

Before deploying, make sure you have:

- **Node.js** v18 or higher
- **npm** v9 or higher
- An **AWS account** with CLI access
- A **MongoDB Atlas** account (or any MongoDB host)
- A server or platform for the backend (Railway, Render, EC2, etc.)
- A platform for the frontend (Vercel, Netlify, S3 static hosting)

---

## Part 1 — AWS Setup

### 1.1 Create Two S3 Buckets

Go to **AWS S3 Console** and create:

| Bucket Name | Purpose |
|---|---|
| `your-app-raw-videos` | Receives the original MP4 uploads |
| `your-app-processed-videos` | Stores the converted HLS files (public) |

> Replace `your-app` with your own prefix throughout this guide.

**For `your-app-processed-videos` — enable public access:**

1. Open the bucket → **Permissions** tab
2. Under **Block Public Access**, click **Edit**
3. Uncheck **Block all public access** → Save
4. Under **Bucket Policy**, add:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadHLS",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::your-app-processed-videos/*"
    }
  ]
}
```

**For `your-app-raw-videos` — add CORS so the browser can PUT directly:**

1. Open the bucket → **Permissions** tab
2. Under **Cross-origin resource sharing (CORS)**, click **Edit** and paste:

```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["PUT"],
    "AllowedOrigins": ["https://your-frontend-domain.com"],
    "ExposeHeaders": ["ETag"]
  }
]
```

> During local development, add `http://localhost:5173` to `AllowedOrigins`.

---

### 1.2 Create an IAM User for the Backend

1. Go to **IAM → Users → Create User**
2. Name it `streamforge-backend`
3. Attach a custom inline policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject"],
      "Resource": "arn:aws:s3:::your-app-raw-videos/*"
    }
  ]
}
```

4. Under the user → **Security credentials** → **Create access key**
5. Copy the `Access Key ID` and `Secret Access Key` — you'll need these for the backend `.env`

---

### 1.3 Add the FFmpeg Lambda Layer

You don't need to build FFmpeg yourself. Use this publicly maintained layer:

**For `us-east-1`:**
```
arn:aws:lambda:us-east-1:145266761615:layer:ffmpeg:1
```

> For other regions, find the right ARN at: https://github.com/nicholaswilde/lambda-ffmpeg-layer

---

### 1.4 Create the Lambda Function

1. Go to **AWS Lambda → Create Function**
2. Choose **Author from scratch**
3. Settings:

| Setting | Value |
|---|---|
| Function name | `streamforge-video-converter` |
| Runtime | `Node.js 20.x` |
| Architecture | `x86_64` |

4. Under **Configuration → General configuration**:
   - Memory: `2048 MB`
   - Timeout: `5 minutes 0 seconds`
   - Ephemeral storage: `1024 MB` (increase to 3072 MB for large videos)

5. Under **Layers → Add a layer**:
   - Choose **Specify an ARN**
   - Paste the FFmpeg ARN from step 1.3

---

### 1.5 Set Lambda IAM Permissions

1. Go to your Lambda → **Configuration → Permissions**
2. Click the execution role name (opens IAM)
3. **Add permissions → Create inline policy**:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject"],
      "Resource": "arn:aws:s3:::your-app-raw-videos/*"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:PutObjectAcl"],
      "Resource": "arn:aws:s3:::your-app-processed-videos/*"
    }
  ]
}
```

---

### 1.6 Deploy the Lambda Code

```bash
cd lambda
npm install
zip -r function.zip index.js package.json node_modules/
```

Then upload in the Lambda console:

1. **Code** tab → **Upload from** → **.zip file**
2. Upload `function.zip`

---

### 1.7 Set Lambda Environment Variables

In Lambda → **Configuration → Environment variables**, add:

| Key | Value |
|---|---|
| `PROCESSED_BUCKET` | `your-app-processed-videos` |
| `BACKEND_WEBHOOK_URL` | `https://your-backend-domain.com/api/videos/webhook` |
| `WEBHOOK_SECRET` | a long random string (keep this private) |
| `FFMPEG_PATH` | `/opt/bin/ffmpeg` |
| `AWS_REGION` | `us-east-1` (or your region) |

> Generate a strong secret with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

---

### 1.8 Add S3 Trigger to Lambda

1. Lambda → **Configuration → Triggers → Add trigger**
2. Source: **S3**
3. Settings:

| Setting | Value |
|---|---|
| Bucket | `your-app-raw-videos` |
| Event types | `PUT` |
| Suffix | `.mp4` |

4. Acknowledge the warning → **Add**

---

## Part 2 — Backend Deployment

### 2.1 Local Development

```bash
cd backend
npm install
cp .env.example .env
# Fill in .env values (see below)
npm run dev
```

**Backend `.env` values:**

```env
PORT=3000
FRONTEND_URL=http://localhost:5173

MONGO_URI=mongodb+srv://<user>:<password>@cluster.mongodb.net/streamforge

AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=<from IAM user step 1.2>
AWS_SECRET_ACCESS_KEY=<from IAM user step 1.2>
RAW_BUCKET=your-app-raw-videos

WEBHOOK_SECRET=<same string you put in Lambda env vars>
```

---

### 2.2 Deploy to Railway (Recommended)

Railway is the fastest way to deploy a Node.js backend with zero DevOps.

1. Push your `backend/` folder to a GitHub repo (or the whole monorepo)
2. Go to [railway.app](https://railway.app) → **New Project → Deploy from GitHub**
3. Select your repo
4. Railway will auto-detect Node.js and run `npm start`
5. Under **Variables**, add all the env vars from `.env.example`
6. Under **Settings → Domains**, generate a public domain
7. Copy the domain (e.g. `https://streamforge-backend.up.railway.app`)

**Update Lambda env var** `BACKEND_WEBHOOK_URL` to `https://streamforge-backend.up.railway.app/api/videos/webhook`

---

### 2.3 Deploy to Render (Alternative)

1. Go to [render.com](https://render.com) → **New → Web Service**
2. Connect your GitHub repo
3. Settings:

| Setting | Value |
|---|---|
| Root directory | `backend` |
| Build command | `npm install` |
| Start command | `npm start` |

4. Add environment variables in the Render dashboard

---

### 2.4 Deploy to AWS EC2 (Self-Managed)

```bash
# On your EC2 instance (Ubuntu)
git clone https://github.com/your/repo.git
cd repo/backend
npm install

# Install PM2 to keep the process alive
npm install -g pm2
pm2 start app.js --name streamforge-backend
pm2 save
pm2 startup

# Set up Nginx as reverse proxy
sudo apt install nginx
# Configure /etc/nginx/sites-available/default to proxy_pass to localhost:3000
# Add SSL with Let's Encrypt: sudo certbot --nginx
```

---

## Part 3 — Frontend Deployment

### 3.1 Local Development

```bash
cd frontend
npm install
cp .env.example .env
# Set VITE_API_URL to your backend URL or leave blank for local proxy
npm run dev
```

Open `http://localhost:5173`

---

### 3.2 Deploy to Vercel (Recommended)

1. Push `frontend/` to GitHub
2. Go to [vercel.com](https://vercel.com) → **New Project**
3. Import your repo
4. Settings:

| Setting | Value |
|---|---|
| Root directory | `frontend` |
| Framework preset | `Vite` |
| Build command | `npm run build` |
| Output directory | `dist` |

5. Add environment variable:
   - `VITE_API_URL` = `https://your-backend-domain.com`

6. Deploy → Vercel gives you a `*.vercel.app` URL

---

### 3.3 Deploy to Netlify (Alternative)

```bash
cd frontend
npm run build
# Drag the dist/ folder into netlify.com/drop
# OR use Netlify CLI:
npm install -g netlify-cli
netlify deploy --prod --dir=dist
```

Add `VITE_API_URL` in Netlify → **Site Settings → Environment Variables**.

---

### 3.4 Update Raw Bucket CORS

Once your frontend is deployed, update the raw bucket CORS rule `AllowedOrigins` to include your Vercel/Netlify domain in addition to localhost.

---

## Part 4 — MongoDB Setup

### 4.1 MongoDB Atlas (Recommended)

1. Create a free account at [cloud.mongodb.com](https://cloud.mongodb.com)
2. Create a new **Cluster** (free M0 tier is fine)
3. Under **Database Access** → Add a database user with password
4. Under **Network Access** → Add IP `0.0.0.0/0` (allow all — fine for development; restrict in production)
5. Under **Clusters** → **Connect** → **Connect your application** → Copy the connection string
6. Replace `<password>` and set database name to `streamforge`:

```
mongodb+srv://myuser:mypassword@cluster0.abc123.mongodb.net/streamforge
```

7. Paste this as `MONGO_URI` in your backend `.env`

---

## Part 5 — Testing the Full Flow

Once everything is deployed:

### Step 1 — Verify backend health
```bash
curl https://your-backend-domain.com/health
# Expected: {"status":"ok","db":"connected"}
```

### Step 2 — Open the frontend
Go to your Vercel/Netlify URL. You should see the **StreamForge** library.

### Step 3 — Upload a video
1. Click **Upload**
2. Drag in a small MP4 file (use a 30-second test video first)
3. Give it a title → **Start Upload & Convert**
4. Watch the progress bar move through: `Requesting URL → Uploading → Converting → Ready`

### Step 4 — Check Lambda logs
In AWS → **Lambda** → your function → **Monitor → View CloudWatch Logs**

You should see:
```
[StreamForge] Starting conversion for videoId=abc-123
[1/4] Downloading from S3...
[1/4] Downloaded: 25.3 MB
[2/4] Running FFmpeg conversion...
[2/4] Conversion complete — 18 files produced
[3/4] Uploading HLS files to S3...
[3/4] All 18 files uploaded
[4/4] Notifying backend webhook...
[4/4] Webhook delivered
```

### Step 5 — Watch the video
Once status turns **ready**, click the video card → HLS.js loads the stream.

---

## API Reference

### `POST /api/videos/presigned-url`
Creates a video record and returns a presigned S3 URL.

**Request:**
```json
{ "title": "My Video" }
```

**Response:**
```json
{
  "videoId": "550e8400-e29b-41d4-a716-446655440000",
  "presignedUrl": "https://your-app-raw-videos.s3.amazonaws.com/uploads/550e...?X-Amz-..."
}
```

---

### `GET /api/videos`
Returns all videos sorted newest first.

**Response:**
```json
[
  {
    "_id": "550e8400-...",
    "title": "My Video",
    "status": "ready",
    "playlistUrl": "https://your-app-processed-videos.s3.amazonaws.com/hls/550e.../playlist.m3u8",
    "createdAt": "2025-01-15T10:30:00.000Z"
  }
]
```

---

### `GET /api/videos/:id`
Returns a single video. Frontend polls this endpoint every 5 seconds while waiting for conversion.

**Status values:**

| Status | Meaning |
|---|---|
| `processing` | Upload received, Lambda is converting |
| `ready` | HLS files are on S3, `playlistUrl` is set |
| `failed` | FFmpeg or S3 error — check CloudWatch |

---

### `POST /api/videos/webhook`
Called by Lambda when conversion finishes. Protected by `x-webhook-secret` header.

**Request:**
```json
{
  "videoId": "550e8400-...",
  "status": "ready",
  "playlistUrl": "https://...processed.../hls/550e.../playlist.m3u8"
}
```

---

## Troubleshooting

### Upload fails immediately
- Check backend is running and `MONGO_URI` is correct
- Check the CORS rule on the raw S3 bucket includes your frontend origin
- Open browser DevTools → Network tab to see the exact error

### Lambda not triggered after upload
- Verify the S3 trigger is configured on the **raw** bucket with suffix `.mp4`
- Check Lambda → Monitor → CloudWatch Logs for invocation records
- Ensure the Lambda IAM role has `s3:GetObject` on the raw bucket

### Lambda fails with "FFmpeg not found"
- Confirm the FFmpeg layer ARN is attached to the function
- Verify `FFMPEG_PATH=/opt/bin/ffmpeg` is set in Lambda env vars
- Check the layer's region matches your Lambda's region

### Webhook not reaching backend
- Make sure `BACKEND_WEBHOOK_URL` in Lambda env vars is the full public HTTPS URL
- Check your backend server is publicly accessible (not just localhost)
- The `WEBHOOK_SECRET` in Lambda and backend `.env` must match exactly

### Video stuck on "processing" forever
- Check CloudWatch logs for Lambda errors
- Verify `PROCESSED_BUCKET` env var matches the actual bucket name
- Check the Lambda execution role has `s3:PutObject` on the processed bucket

### CORS error in browser when streaming
- The processed S3 bucket must have public read access enabled
- Add a CORS policy to the processed bucket if needed (same format as raw bucket)

---

## Environment Variables Summary

### Backend `.env`
| Variable | Description |
|---|---|
| `PORT` | Server port (default: 3000) |
| `FRONTEND_URL` | Frontend origin for CORS |
| `MONGO_URI` | MongoDB connection string |
| `AWS_REGION` | AWS region (e.g. us-east-1) |
| `AWS_ACCESS_KEY_ID` | IAM access key |
| `AWS_SECRET_ACCESS_KEY` | IAM secret key |
| `RAW_BUCKET` | S3 bucket for raw MP4 uploads |
| `WEBHOOK_SECRET` | Shared secret for Lambda → backend auth |

### Frontend `.env`
| Variable | Description |
|---|---|
| `VITE_API_URL` | Backend base URL |

### Lambda Environment Variables
| Variable | Description |
|---|---|
| `PROCESSED_BUCKET` | S3 bucket for HLS output |
| `BACKEND_WEBHOOK_URL` | Full webhook endpoint URL |
| `WEBHOOK_SECRET` | Must match backend `WEBHOOK_SECRET` |
| `FFMPEG_PATH` | Path to FFmpeg binary in layer |
| `AWS_REGION` | AWS region |

---

## Cost Estimate (AWS Free Tier)

| Service | Free Tier | Typical usage |
|---|---|---|
| S3 Storage | 5 GB | Grows with video library |
| S3 Requests | 20,000 GET / 2,000 PUT | Low |
| Lambda invocations | 1,000,000/month | Each upload = 1 invocation |
| Lambda duration | 400,000 GB-seconds | ~30s × 2GB = 60 GB-s per video |
| Data transfer out | 1 GB/month | Streaming cost |

> For a hobby project processing a few videos a day, AWS costs will be near zero within free tier limits.

---

## License

MIT