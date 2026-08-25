export const bridgeProtocolVersion = 1

export type BridgeEnvelope = { iv: string; ciphertext: string }

export type BridgePendingRequest = {
  id: string
  deviceName: string
  devicePublicKey: JsonWebKey
  fingerprint: string
  createdAt: string
}

export type BridgeChannelStatus = {
  channelId: string
  bridgeUrl: string
  enrollmentExpiresAt: string
  invitation: string
  pendingRequests: BridgePendingRequest[]
  approvedDevices: Array<{ id: string; name: string; approvedAt: string }>
}

export type HandoverCatalog = {
  projects: Array<{
    id: string
    name: string
    conversations: Array<{ id: string; title: string; updatedAt?: string }>
  }>
  updatedAt: string
}

export type HandoverConversation = {
  projectId: string
  conversationId: string
  title: string
  messages: Array<{
    id: string
    role: 'user' | 'assistant'
    content: string
    blocks?: Array<{ type: 'content'; content: string }>
    createdAt?: string
  }>
  updatedAt: string
}

export type HandoverUserMessage = {
  projectId: string
  conversationId: string
  clientMessageId: string
  content: string
}
