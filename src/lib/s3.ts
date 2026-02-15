import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import crypto from 'crypto'

const s3Client = new S3Client({
  endpoint: process.env.S3_ENDPOINT || 'http://localhost:9000',
  region: process.env.S3_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY || 'minioadmin',
    secretAccessKey: process.env.S3_SECRET_KEY || 'minioadmin',
  },
  forcePathStyle: true, // Required for MinIO
})

const BUCKET = process.env.S3_BUCKET || 'bidroom-documents'

export async function uploadFile(
  file: Buffer,
  filename: string,
  mimeType: string,
  folder?: string
): Promise<{ key: string; hash: string }> {
  // Generate hash for deduplication
  const hash = crypto.createHash('sha256').update(file).digest('hex')
  
  // Generate unique key
  const key = folder 
    ? `${folder}/${Date.now()}-${filename}`
    : `${Date.now()}-${filename}`

  await s3Client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: file,
      ContentType: mimeType,
    })
  )

  return { key, hash }
}

export async function getFileUrl(key: string, expiresIn = 3600): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: BUCKET,
    Key: key,
  })

  return await getSignedUrl(s3Client, command, { expiresIn })
}

export async function deleteFile(key: string): Promise<void> {
  await s3Client.send(
    new DeleteObjectCommand({
      Bucket: BUCKET,
      Key: key,
    })
  )
}

export async function downloadFile(key: string): Promise<Buffer> {
  const command = new GetObjectCommand({
    Bucket: BUCKET,
    Key: key,
  })

  const response = await s3Client.send(command)
  const chunks: Uint8Array[] = []
  
  if (response.Body) {
    for await (const chunk of response.Body as any) {
      chunks.push(chunk)
    }
  }

  return Buffer.concat(chunks)
}
