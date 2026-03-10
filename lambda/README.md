# Lambda Deployment Guide

This guide covers the exact steps taken to deploy the StreamForge video conversion
Lambda function, including building the FFmpeg layer from scratch on Windows.

---

## Overview

The Lambda function is responsible for:
1. Receiving an S3 trigger when an MP4 is uploaded to the raw bucket
2. Downloading the MP4 from S3 to `/tmp`
3. Running FFmpeg to convert it to HLS (m3u8 + .ts segments)
4. Generating a thumbnail at the 2-second mark
5. Uploading all output files to the processed S3 bucket
6. Notifying the backend webhook with the playlist URL and thumbnail URL

---

## Part 1 — Build the FFmpeg Lambda Layer

Lambda does not include FFmpeg by default. You need to package the FFmpeg binary
as a Lambda Layer and attach it to your function. The binary must sit at `bin/ffmpeg`
inside the zip so Lambda mounts it at `/opt/bin/ffmpeg`.

### Why build your own layer?

Public FFmpeg layers from third-party AWS accounts require that account to have
granted your account access via a resource-based policy. If they haven't, you get:

```
User is not authorized to perform: lambda:GetLayerVersion on resource: arn:aws:lambda:...
```

Building your own layer in your own AWS account avoids this entirely.

---

### Step 1.1 — Fix your system clock (Windows)

AWS signatures expire if your system clock is out of sync. Before doing anything,
make sure your clock is correct:

1. Press `Windows + I` → **Time & Language → Date & Time**
2. Turn **Set time automatically** → **On**
3. Turn **Set time zone automatically** → **On**
4. Click **Sync now**
5. Verify at **time.is** that your clock shows as synchronized

> Skipping this step causes `Signature expired` errors when uploading to AWS.

---

### Step 1.2 — Download the FFmpeg static binary

Open **Git Bash** and run:

```bash
# Create the exact folder structure Lambda expects
mkdir -p ffmpeg-layer/bin

# Download a pre-built static FFmpeg binary for Linux x86_64
curl -L https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz \
  -o ffmpeg.tar.xz

# Extract just the ffmpeg binary into the bin folder
tar -xJf ffmpeg.tar.xz --strip-components=1 --wildcards '*/ffmpeg' -C ffmpeg-layer/bin/

# Verify it extracted correctly — you should see the ffmpeg binary listed
ls -lh ffmpeg-layer/bin/ffmpeg
```

Expected output:
```
-rwxr-xr-x 1 user user 79M Mar 10 12:00 ffmpeg-layer/bin/ffmpeg
```

---

### Step 1.3 — Zip the layer

`zip` is not available in Git Bash on Windows by default. Use **PowerShell** instead:

```powershell
# Navigate to the folder containing ffmpeg-layer/
cd path\to\your\project

# Create the zip — bin/ folder must be at the root of the zip
Compress-Archive -Path ffmpeg-layer\bin -DestinationPath ffmpeg-layer.zip
```

> Do the upload immediately after creating the zip. AWS presigned URLs used during
> upload have a short expiry window, and a delayed upload can trigger signature errors.

---

### Step 1.4 — Create the Lambda Layer in AWS Console

1. Go to **AWS Console → Lambda → Layers → Create layer**
2. Fill in the details:

| Field | Value |
|---|---|
| Name | `ffmpeg` |
| Description | FFmpeg static binary for video conversion |
| Upload | Select `ffmpeg-layer.zip` from your machine |
| Compatible architectures | `x86_64` |
| Compatible runtimes | `Node.js 20.x` |

3. Click **Create**
4. Copy the **Layer ARN** shown on the confirmation page — you will need it in the next step

> The ARN looks like: `arn:aws:lambda:eu-central-1:992382803030:layer:ffmpeg:1`

---

## Part 2 — Create the Lambda Function

### Step 2.1 — Create the function

1. Go to **AWS Console → Lambda → Create function**
2. Choose **Author from scratch**
3. Settings:

| Setting | Value |
|---|---|
| Function name | `streamforge-video-converter` |
| Runtime | `Node.js 20.x` |
| Architecture | `x86_64` |
| Compute type | `Lambda default` |
| Function URL | Disabled |

4. Click **Create function**

---

### Step 2.2 — Configure memory and timeout

Lambda allocates CPU proportionally to memory. FFmpeg is CPU-intensive so set
memory to the maximum Lambda allows:

1. Lambda → **Configuration → General configuration → Edit**
2. Settings:

| Setting | Value |
|---|---|
| Memory | `3008 MB` (maximum allowed) |
| Timeout | `5 min 0 sec` |
| Ephemeral storage (/tmp) | `1024 MB` (increase to 3072 MB for very large videos) |

3. Click **Save**

> AWS enforces a hard limit of 3008 MB. You cannot exceed this in Lambda.

---

### Step 2.3 — Attach the FFmpeg layer

1. Scroll down to the **Layers** section → click **Add a layer**
2. Select **Specify an ARN**
3. Paste the Layer ARN you copied in Step 1.4
4. Click **Verify** — AWS will confirm the layer exists
5. Click **Add**

You should now see **Layers (1)** showing your ffmpeg layer.

---

### Step 2.4 — Set IAM permissions

The Lambda execution role needs permission to read from the raw bucket and write
to the processed bucket:

1. Lambda → **Configuration → Permissions** → click the execution role name
2. **Add permissions → Create inline policy**
3. Switch to the **JSON** tab and paste:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject"],
      "Resource": "arn:aws:s3:::streamforge-raw-videos/*"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject"],
      "Resource": "arn:aws:s3:::streamforge-processed-videos/*"
    }
  ]
}
```

4. Name the policy `streamforge-lambda-s3` → click **Create policy**

---

### Step 2.5 — Set environment variables

1. Lambda → **Configuration → Environment variables → Edit → Add environment variable**
2. Add these four variables:

| Key | Value |
|---|---|
| `PROCESSED_BUCKET` | `streamforge-processed-videos` |
| `BACKEND_WEBHOOK_URL` | `https://your-backend-domain.com/api/videos/webhook` |
| `WEBHOOK_SECRET` | same secret string used in backend `.env` |
| `FFMPEG_PATH` | `/opt/bin/ffmpeg` |

3. Click **Save**

> Do NOT add `AWS_REGION` — it is a reserved key that AWS sets automatically.
> Adding it causes: `MemorySize value failed to satisfy constraint` or environment variable errors.

---

## Part 3 — Deploy the Function Code

### Step 3.1 — Package the code

In Git Bash from the `lambda/` folder:

```bash
cd lambda
npm install
zip -r function.zip index.js package.json node_modules/
```

> If `zip` is not available in Git Bash, install it first:
> ```bash
> sudo apt install zip -y   # Linux/WSL
> ```
> Or use PowerShell:
> ```powershell
> Compress-Archive -Path index.js, package.json, node_modules `
>   -DestinationPath function.zip
> ```

---

### Step 3.2 — Upload the code

1. Lambda → **Code** tab → **Upload from → .zip file**
2. Select `function.zip`
3. Click **Save**

You should see your `index.js` appear in the code editor.

---

## Part 4 — Add the S3 Trigger

This tells S3 to automatically invoke the Lambda function whenever a new MP4
is uploaded to the raw bucket.

1. Lambda → **Configuration → Triggers → Add trigger**
2. Source: **S3**
3. Settings:

| Setting | Value |
|---|---|
| Bucket | `streamforge-raw-videos` |
| Event types | `s3:ObjectCreated:*` |
| Suffix | `.mp4` |

4. Acknowledge the recursive invocation warning → **Add**

> **Important:** Use `s3:ObjectCreated:*` and NOT just `PUT`.
> Single-part uploads fire a `PUT` event, but multipart uploads (used for files
> over 50MB) fire a `CompleteMultipartUpload` event. Using `*` catches both.
> Using only `PUT` means Lambda never triggers for large file uploads.

---

## Part 5 — Verify the Deployment

### Test via CloudWatch Logs

After uploading a video through the frontend, go to:

**Lambda → Monitor → View CloudWatch Logs → latest log stream**

A successful run looks like:

```
[StreamForge] Starting for videoId=abc-123
[1/5] Downloading from S3...
[1/5] Downloaded: 25.3 MB
[2/5] Running FFmpeg HLS conversion...
[2/5] Conversion complete — 18 files produced
[3/5] Generating thumbnail...
[3/5] Thumbnail generated
[4/5] Uploading all files to S3...
[4/5] Upload complete — thumbnail: https://...
[5/5] Notifying backend webhook
[5/5] Webhook delivered
```

### Check the Monitor tab

Lambda → **Monitor** tab shows:

| Metric | What it means |
|---|---|
| Invocations | How many times Lambda was triggered |
| Error count | How many invocations failed |
| Duration | How long each run took |

Zero invocations after an upload means the S3 trigger is misconfigured.

---

## Errors Encountered and How They Were Fixed

| Error | Cause | Fix |
|---|---|---|
| `User is not authorized to perform: lambda:GetLayerVersion` | Third-party layer account has not granted public access | Build your own FFmpeg layer in your own account |
| `Signature expired` | System clock out of sync with AWS | Enable automatic time sync in Windows settings |
| `zip: command not found` | Git Bash on Windows lacks zip | Use PowerShell `Compress-Archive` instead |
| `/opt/bin/ffmpeg: No such file or directory` | FFmpeg zip had wrong folder structure | Ensure binary is at `bin/ffmpeg` inside the zip |
| `The bucket does not allow ACLs` | New S3 buckets have ACLs disabled by default | Remove `ACL: "public-read"` from `PutObjectCommand` and use bucket policy instead |
| `Reserved keys: AWS_REGION` | AWS does not allow overriding reserved env vars | Remove `AWS_REGION` from Lambda environment variables |
| `Invalid URL` | Typo in `BACKEND_WEBHOOK_URL` (`https;` instead of `https:`) | Fix the colon in the environment variable value |
| Lambda triggers for small files but not large files | S3 trigger was set to `PUT` only — multipart uploads fire a different event | Change S3 trigger event type to `s3:ObjectCreated:*` |
| `AccessControlListNotSupported` | Attempted to set `ACL: public-read` on a bucket with ACLs disabled | Removed ACL from code, use bucket policy for public access |