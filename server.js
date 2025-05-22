require("dotenv").config()
const express = require("express")
const bodyParser = require("body-parser")
const { MongoClient, ObjectId } = require("mongodb")
const cors = require("cors")
const fetch = require("node-fetch")

// Initialize Express app
const app = express()
const PORT = process.env.PORT || 3001

// Middleware
app.use(cors())
app.use(bodyParser.json({ limit: "10mb" }))

// MongoDB connection with improved options
const MONGODB_URI = process.env.MONGODB_URI
let client
let db

// Connect to MongoDB with improved options
async function connectToMongoDB() {
  try {
    client = new MongoClient(MONGODB_URI, {
      connectTimeoutMS: 30000,
      socketTimeoutMS: 45000,
      serverSelectionTimeoutMS: 60000,
      maxPoolSize: 10,
      minPoolSize: 5,
      maxIdleTimeMS: 120000,
    })
    await client.connect()
    db = client.db("instaautodm")
    console.log("Connected to MongoDB")
  } catch (error) {
    console.error("Error connecting to MongoDB:", error)
    // Attempt to reconnect after a delay
    setTimeout(connectToMongoDB, 5000)
  }
}

// Authentication middleware
function authenticateRequest(req, res, next) {
  const authHeader = req.headers.authorization

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" })
  }

  const token = authHeader.split(" ")[1]

  if (token !== process.env.RENDER_SERVER_API_KEY) {
    return res.status(403).json({ error: "Forbidden" })
  }

  next()
}

// Routes
app.get("/", (req, res) => {
  res.send("Instagram Automation Server is running")
})

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date() })
})

// Process events from the main app
app.post("/api/process-event", authenticateRequest, async (req, res) => {
  try {
    const { type, data } = req.body

    console.log(`Processing ${type} event:`, JSON.stringify(data))

    // Log the event
    await db.collection("processedEvents").insertOne({
      type,
      data,
      timestamp: new Date(),
      processed: false,
    })

    let result

    // Process different event types
    switch (type) {
      case "comment":
        result = await processComment(data)
        break
      case "button_click":
        result = await processButtonClick(data)
        break
      case "message":
        result = await processMessage(data)
        break
      default:
        throw new Error(`Unknown event type: ${type}`)
    }

    // Update the event as processed
    await db
      .collection("processedEvents")
      .updateOne(
        { type, "data.id": data.id || data.mid || data.sender?.id },
        { $set: { processed: true, processedAt: new Date(), result } },
      )

    res.json({ success: true, result })
  } catch (error) {
    console.error("Error processing event:", error)

    // Log the error
    await db.collection("serverErrors").insertOne({
      error: String(error),
      stack: error.stack,
      request: req.body,
      timestamp: new Date(),
    })

    res.status(500).json({ error: String(error) })
  }
})

// Process a comment
async function processComment(comment) {
  try {
    console.log(`Processing comment: ${comment.id} on media ${comment.media_id} from ${comment.from?.username}`)

    // Find the post in our database
    const post = await findOrCreatePost(comment.media_id)

    if (!post) {
      throw new Error(`Could not find or create post for media ${comment.media_id}`)
    }

    // Find the Instagram account for this post
    const instagramAccount = await db.collection("instagramAccounts").findOne({
      _id: post.instagramAccountId,
    })

    if (!instagramAccount) {
      throw new Error(`Instagram account ${post.instagramAccountId} not found`)
    }

    // Process the comment with automations
    return await processCommentWithAutomations(comment, post, instagramAccount)
  } catch (error) {
    console.error("Error processing comment:", error)
    throw error
  }
}

// Find or create a post
async function findOrCreatePost(mediaId) {
  try {
    // Find the post by Instagram media ID
    const post = await db.collection("posts").findOne({ instagramId: mediaId })

    if (post) {
      return post
    }

    // If post not found, try to find a matching account and create the post
    const accounts = await db.collection("instagramAccounts").find({}).toArray()

    for (const account of accounts) {
      try {
        // Validate token before using
        if (!account.accessToken || account.accessToken.includes("undefined") || account.accessToken.includes("null")) {
          console.log(`Invalid token format for account ${account.username}, skipping`)
          continue
        }

        // Try to fetch the post details using the account's token
        const token = account.pageAccessToken || account.accessToken
        if (!token) continue

        const response = await fetch(
          `https://graph.facebook.com/v18.0/${mediaId}?fields=id,permalink,caption&access_token=${token}`,
          { next: { revalidate: 0 } },
        )

        if (response.ok) {
          const postData = await response.json()

          // Create a new post
          const newPost = {
            _id: new ObjectId().toString(),
            instagramAccountId: account._id,
            instagramId: mediaId,
            caption: postData.caption || "",
            permalink: postData.permalink || "",
            createdAt: new Date(),
            updatedAt: new Date(),
          }

          await db.collection("posts").insertOne(newPost)
          console.log(`Created new post for media ${mediaId}`)

          return newPost
        }
      } catch (error) {
        console.error(`Error fetching post details with account ${account.username}:`, error)
      }
    }

    return null
  } catch (error) {
    console.error("Error finding or creating post:", error)
    return null
  }
}

// Process a comment with automations
async function processCommentWithAutomations(comment, post, instagramAccount) {
  try {
    // Store the comment in the database if it doesn't exist
    const existingComment = await db.collection("comments").findOne({ commentId: comment.id })

    if (!existingComment) {
      await db.collection("comments").insertOne({
        _id: new ObjectId().toString(),
        commentId: comment.id,
        mediaId: comment.media_id,
        postId: post._id,
        text: comment.text || "",
        username: comment.from?.username || "unknown",
        userId: comment.from?.id || "unknown",
        createdAt: new Date(),
        processed: false,
      })
    } else if (existingComment.processed) {
      // Skip if already processed
      return {
        success: true,
        message: `Comment ${comment.id} already processed`,
        processed: false,
      }
    }

    // Find automations for this post
    const automations = await db
      .collection("automations")
      .find({
        $or: [
          { postId: post._id },
          { postId: { $exists: false } }, // "any post" automations
          { postId: null }, // "any post" automations
        ],
        instagramAccountId: instagramAccount._id,
        active: true,
      })
      .toArray()

    if (automations.length === 0) {
      console.log(`No active automations found for post ${post._id}`)
      return {
        success: true,
        message: `No active automations found for post ${post._id}`,
        processed: false,
      }
    }

    console.log(`Found ${automations.length} automations for post ${post._id}`)

    let messagesSent = 0

    // Process each automation
    for (const automation of automations) {
      // Check if the comment contains the trigger keyword
      const triggerMatched =
        automation.triggerKeyword === "any" ||
        (comment.text && comment.text.toLowerCase().includes(automation.triggerKeyword.toLowerCase()))

      if (!triggerMatched) {
        console.log(`Trigger "${automation.triggerKeyword}" not matched in comment: ${comment.text}`)
        continue
      }

      console.log(`Trigger "${automation.triggerKeyword}" matched in comment from ${comment.from?.username}`)

      // Check if we've already sent a DM to this user for this automation
      const existingDM = await db.collection("directMessages").findOne({
        automationId: automation._id,
        recipientUsername: comment.from?.username,
      })

      if (existingDM) {
        console.log(`Already sent a DM to ${comment.from?.username} for automation ${automation._id}`)
        continue
      }

      // Check rate limiting
      const now = new Date()
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000)

      const recentDMs = await db.collection("directMessages").countDocuments({
        automationId: automation._id,
        sentAt: { $gte: oneHourAgo },
        status: "sent",
      })

      if (recentDMs >= (automation.rateLimit || 10)) {
        console.log(`Rate limit reached for automation ${automation._id}`)
        continue
      }

      // Validate token before using
      if (
        !instagramAccount.accessToken ||
        instagramAccount.accessToken.includes("undefined") ||
        instagramAccount.accessToken.includes("null")
      ) {
        console.log(`Invalid token format for account ${instagramAccount.username}, skipping automation`)
        continue
      }

      // Get a valid token for this account
      const validToken = instagramAccount.pageAccessToken || instagramAccount.accessToken

      if (!validToken) {
        console.error(`No valid token available for account ${instagramAccount.username}`)
        continue
      }

      // Reply to the comment if enabled
      if (automation.replyToComments) {
        try {
          await replyToComment(validToken, comment.id, automation.commentReply || "Thanks! Please check your DMs.")

          console.log(`Replied to comment ${comment.id}`)

          // Log the comment reply
          await db.collection("commentReplies").insertOne({
            _id: new ObjectId().toString(),
            automationId: automation._id,
            commentId: comment.id,
            username: comment.from?.username || "unknown",
            reply: automation.commentReply || "Thanks! Please check your DMs.",
            status: "sent",
            sentAt: new Date(),
          })
        } catch (error) {
          console.error(`Error replying to comment ${comment.id}:`, error)
        }
      }

      // Send the DM
      try {
        let messageResult

        if (automation.useOpeningMessage) {
          // Try to send opening message with button
          const openingMessage =
            automation.openingMessage ||
            "Hey there! I'm so happy you're here, thanks so much for your interest 😊\n\nClick below and I'll send you the link in just a sec ✨"

          const buttonText = automation.buttonText || "Send me the link"

          try {
            await sendDirectMessageWithButton(
              validToken,
              instagramAccount.instagramId,
              comment.from?.username || "unknown",
              openingMessage,
              buttonText,
              automation._id,
            )

            // Log the sent opening DM
            await db.collection("directMessages").insertOne({
              _id: new ObjectId().toString(),
              automationId: automation._id,
              recipientUsername: comment.from?.username || "unknown",
              commentId: comment.id,
              message: openingMessage,
              type: "opening",
              status: "sent",
              sentAt: new Date(),
            })

            messageResult = { success: true, method: "dm_button" }
          } catch (buttonError) {
            console.error(`Error sending DM with button to ${comment.from?.username}:`, buttonError)

            // Try fallback to regular DM with fallback
            try {
              let fullMessage = openingMessage + "\n\n" + automation.message

              if (automation.addBranding) {
                fullMessage += `\n\n${automation.brandingMessage || "⚡ Sent via ChatAutoDM — grow your DMs on autopilot"}`
              }

              messageResult = await sendDirectMessageWithFallback(
                validToken,
                instagramAccount.instagramId,
                comment.from?.username || "unknown",
                fullMessage,
                comment.id,
              )

              // Log the sent message
              await db.collection("directMessages").insertOne({
                _id: new ObjectId().toString(),
                automationId: automation._id,
                recipientUsername: comment.from?.username || "unknown",
                commentId: comment.id,
                message: fullMessage,
                type: messageResult.method === "dm" ? "direct" : "comment_fallback",
                status: "sent",
                sentAt: new Date(),
              })
            } catch (fallbackError) {
              throw fallbackError
            }
          }
        } else {
          // Send direct message with fallback
          let fullMessage = automation.message || "Thank you for your comment!"

          if (automation.addBranding) {
            fullMessage += `\n\n${automation.brandingMessage || "⚡ Sent via ChatAutoDM — grow your DMs on autopilot"}`
          }

          messageResult = await sendDirectMessageWithFallback(
            validToken,
            instagramAccount.instagramId,
            comment.from?.username || "unknown",
            fullMessage,
            comment.id,
          )

          // Log the sent message
          await db.collection("directMessages").insertOne({
            _id: new ObjectId().toString(),
            automationId: automation._id,
            recipientUsername: comment.from?.username || "unknown",
            commentId: comment.id,
            message: fullMessage,
            type: messageResult.method === "dm" ? "direct" : "comment_fallback",
            status: "sent",
            sentAt: new Date(),
          })
        }

        messagesSent++

        // Update automation stats
        await db.collection("automations").updateOne(
          { _id: automation._id },
          {
            $inc: { totalDMsSent: 1 },
            $set: { lastTriggered: new Date() },
          },
        )

        console.log(
          `Sent message to ${comment.from?.username} via ${messageResult.method} for automation ${automation._id}`,
        )
      } catch (error) {
        console.error(`Error sending message to ${comment.from?.username}:`, error)

        // Log the failed message
        await db.collection("directMessages").insertOne({
          _id: new ObjectId().toString(),
          automationId: automation._id,
          recipientUsername: comment.from?.username || "unknown",
          commentId: comment.id,
          message: automation.useOpeningMessage ? automation.openingMessage : automation.message,
          status: "failed",
          error: String(error),
          sentAt: new Date(),
        })
      }
    }

    // Mark the comment as processed
    await db
      .collection("comments")
      .updateMany({ commentId: comment.id }, { $set: { processed: true, processedAt: new Date() } })

    return {
      success: true,
      message: `Processed comment ${comment.id}`,
      processed: true,
      messagesSent,
    }
  } catch (error) {
    console.error("Error processing comment with automations:", error)
    return {
      success: false,
      message: `Error: ${error.message}`,
      processed: false,
    }
  }
}

// Process a button click
async function processButtonClick(data) {
  try {
    const { automationId, senderId, recipientId } = data

    console.log(`Processing button click: automation=${automationId}, sender=${senderId}, recipient=${recipientId}`)

    // Find the automation
    const automation = await db.collection("automations").findOne({ _id: automationId })

    if (!automation) {
      throw new Error(`Automation ${automationId} not found`)
    }

    // Get the Instagram account
    const instagramAccount = await db.collection("instagramAccounts").findOne({
      _id: automation.instagramAccountId,
    })

    if (!instagramAccount) {
      throw new Error(`Instagram account ${automation.instagramAccountId} not found`)
    }

    // Validate token before using
    if (
      !instagramAccount.accessToken ||
      instagramAccount.accessToken.includes("undefined") ||
      instagramAccount.accessToken.includes("null")
    ) {
      throw new Error(`Invalid token format for account ${instagramAccount.username}`)
    }

    // Send the main content message
    let fullMessage = automation.message || "Thank you for your interest!"

    if (automation.addBranding) {
      fullMessage += `\n\n${automation.brandingMessage || "⚡ Sent via ChatAutoDM — grow your DMs on autopilot"}`
    }

    // Get username from ID
    let username = "user"
    try {
      const token = instagramAccount.pageAccessToken || instagramAccount.accessToken
      const userResponse = await fetch(
        `https://graph.facebook.com/v18.0/${senderId}?fields=username&access_token=${token}`,
        { cache: "no-store" },
      )
      if (userResponse.ok) {
        const userData = await userResponse.json()
        username = userData.username || username
      }
    } catch (error) {
      console.error("Error getting username:", error)
    }

    // Send the DM
    const dmResponse = await fetch(`https://graph.facebook.com/v18.0/${instagramAccount.instagramId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipient: { id: senderId },
        message: { text: fullMessage },
        access_token: instagramAccount.pageAccessToken || instagramAccount.accessToken,
      }),
    })

    if (!dmResponse.ok) {
      const errorData = await dmResponse.json()
      throw new Error(`Failed to send direct message: ${JSON.stringify(errorData)}`)
    }

    // Log the sent DM
    await db.collection("directMessages").insertOne({
      _id: new ObjectId().toString(),
      automationId: automation._id,
      userId: instagramAccount.userId,
      instagramAccountId: instagramAccount._id,
      recipientUsername: username,
      recipientId: senderId,
      message: fullMessage,
      status: "sent",
      sentAt: new Date(),
    })

    // Update automation stats
    await db.collection("automations").updateOne(
      { _id: automation._id },
      {
        $inc: { totalDMsSent: 1 },
        $set: { lastTriggered: new Date() },
      },
    )

    console.log(`Sent content DM to ${username} for automation ${automation._id}`)

    return {
      success: true,
      message: `Sent content DM to ${username} for automation ${automation._id}`,
    }
  } catch (error) {
    console.error("Error processing button click:", error)
    return {
      success: false,
      message: `Error: ${error.message}`,
    }
  }
}

// Process a message
async function processMessage(messageData) {
  try {
    const { sender, recipient, message, timestamp } = messageData

    console.log(`Processing message from ${sender.id} to ${recipient.id}: "${message?.text || "No text"}"`, {
      timestamp: new Date().toISOString(),
      messageData,
    })

    // Find the Instagram account by recipient ID
    const instagramAccount = await db.collection("instagramAccounts").findOne({
      instagramId: recipient.id,
    })

    if (!instagramAccount) {
      console.log(`Instagram account with ID ${recipient.id} not found`)
      return {
        success: false,
        message: `Instagram account with ID ${recipient.id} not found`,
      }
    }

    console.log(`Found Instagram account: ${instagramAccount.username} for recipient ID: ${recipient.id}`)

    // Store the message in the database with high priority
    const messageId = new ObjectId().toString()
    await db.collection("incomingMessages").insertOne({
      _id: messageId,
      senderId: sender.id,
      senderUsername: sender.username || "unknown",
      recipientId: recipient.id,
      instagramAccountId: instagramAccount._id,
      message: message?.text || "",
      timestamp: new Date(timestamp || Date.now()),
      createdAt: new Date(),
      highPriority: true,
      processed: false,
    })

    // Find or create contact with improved error handling
    let contact = await db.collection("contacts").findOne({
      instagramAccountId: instagramAccount._id,
      senderId: sender.id,
    })

    if (!contact) {
      // Try to get username from Facebook Graph API with better error handling
      let username = sender.username || "unknown"
      try {
        const token = instagramAccount.pageAccessToken || instagramAccount.accessToken
        if (token && !token.includes("undefined") && !token.includes("null")) {
          const userResponse = await fetch(
            `https://graph.facebook.com/v18.0/${sender.id}?fields=username&access_token=${token}`,
            {
              cache: "no-store",
              timeout: 5000, // 5 second timeout
            },
          )
          if (userResponse.ok) {
            const userData = await userResponse.json()
            username = userData.username || sender.username || "unknown"
          }
        }
      } catch (error) {
        console.error("Error getting username:", error)
      }

      // Create new contact
      const newContact = {
        _id: new ObjectId().toString(),
        userId: instagramAccount.userId,
        instagramAccountId: instagramAccount._id,
        senderId: sender.id,
        username: username.toLowerCase(),
        displayName: username,
        lastMessage: message?.text || "",
        lastMessageTime: new Date(),
        unread: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      }

      await db.collection("contacts").insertOne(newContact)
      contact = newContact
      console.log(`Created new contact: ${username} for sender ID: ${sender.id}`)
    } else {
      // Update last message
      await db.collection("contacts").updateOne(
        { _id: contact._id },
        {
          $set: {
            lastMessage: message?.text || "",
            lastMessageTime: new Date(),
            unread: true,
            updatedAt: new Date(),
          },
        },
      )
      console.log(`Updated existing contact: ${contact.username} with new message`)
    }

    // Check for automated responses based on message content
    const automations = await db
      .collection("automations")
      .find({
        instagramAccountId: instagramAccount._id,
        type: "message",
        active: true,
      })
      .toArray()

    console.log(`Found ${automations.length} active message automations for account ${instagramAccount.username}`)

    let messagesSent = 0

    // Process automations with improved error handling and logging
    for (const automation of automations) {
      try {
        // Check if trigger matches
        if (
          (message?.text && message.text.toLowerCase().includes(automation.triggerKeyword.toLowerCase())) ||
          automation.triggerKeyword === "any"
        ) {
          console.log(`Trigger "${automation.triggerKeyword}" matched in message from ${sender.id}`)

          // Check rate limiting
          const now = new Date()
          const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000)

          const recentDMs = await db.collection("directMessages").countDocuments({
            automationId: automation._id,
            sentAt: { $gte: oneHourAgo },
            status: "sent",
          })

          if (recentDMs >= (automation.rateLimit || 10)) {
            console.log(`Rate limit reached for automation ${automation._id}`)
            continue
          }

          // Validate token before using
          if (
            !instagramAccount.accessToken ||
            instagramAccount.accessToken.includes("undefined") ||
            instagramAccount.accessToken.includes("null")
          ) {
            console.log(`Invalid token format for account ${instagramAccount.username}, skipping automation`)
            continue
          }

          // Send the automated response with retry logic
          let responseMessage = automation.message || "Thank you for your message!"

          if (automation.addBranding) {
            responseMessage += `\n\n${automation.brandingMessage || "⚡ Sent via ChatAutoDM — grow your DMs on autopilot"}`
          }

          // Send the DM with retry logic
          let success = false
          let error = null

          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              // Send the DM directly using the Graph API
              const token = instagramAccount.pageAccessToken || instagramAccount.accessToken
              const dmResponse = await fetch(
                `https://graph.facebook.com/v18.0/${instagramAccount.instagramId}/messages`,
                {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    recipient: { id: sender.id },
                    message: { text: responseMessage },
                    access_token: token,
                  }),
                  cache: "no-store",
                },
              )

              if (!dmResponse.ok) {
                const errorData = await dmResponse.json()
                throw new Error(`Failed to send direct message: ${JSON.stringify(errorData)}`)
              }

              success = true
              break // Exit retry loop on success
            } catch (sendError) {
              console.error(`Attempt ${attempt} - Error sending automated response to ${sender.id}:`, sendError)
              error = sendError

              // Wait before retry (exponential backoff)
              if (attempt < 3) {
                await new Promise((resolve) => setTimeout(resolve, attempt * 1000))
              }
            }
          }

          // Log the result
          if (success) {
            // Log the sent response
            await db.collection("directMessages").insertOne({
              _id: new ObjectId().toString(),
              automationId: automation._id,
              userId: instagramAccount.userId,
              instagramAccountId: instagramAccount._id,
              recipientUsername: contact.username,
              recipientId: sender.id,
              message: responseMessage,
              status: "sent",
              sentAt: new Date(),
              isAutomated: true,
            })

            // Add to messages collection for UI display
            await db.collection("messages").insertOne({
              contactId: contact._id,
              instagramAccountId: instagramAccount._id,
              fromMe: true,
              message: responseMessage,
              timestamp: new Date(),
              isAutomated: true,
            })

            // Update automation stats
            await db.collection("automations").updateOne(
              { _id: automation._id },
              {
                $inc: { totalDMsSent: 1 },
                $set: { lastTriggered: new Date() },
              },
            )

            messagesSent++
            console.log(`Successfully sent automated response to ${contact.username}`)
          } else {
            // Log the failed response
            await db.collection("directMessages").insertOne({
              _id: new ObjectId().toString(),
              automationId: automation._id,
              userId: instagramAccount.userId,
              instagramAccountId: instagramAccount._id,
              recipientUsername: contact.username,
              recipientId: sender.id,
              message: responseMessage,
              status: "failed",
              error: String(error),
              sentAt: new Date(),
              isAutomated: true,
            })
          }
        }
      } catch (automationError) {
        console.error(`Error processing automation ${automation._id}:`, automationError)
      }
    }

    // Mark the message as processed
    await db
      .collection("incomingMessages")
      .updateMany(
        { senderId: sender.id, recipientId: recipient.id, processed: false },
        { $set: { processed: true, processedAt: new Date() } },
      )

    return {
      success: true,
      message: `Processed message from ${sender.id}`,
      messagesSent,
      contactId: contact._id,
    }
  } catch (error) {
    console.error("Error processing message:", error)
    return {
      success: false,
      message: `Error: ${error.message}`,
      error: String(error),
    }
  }
}

// Reply to a comment
async function replyToComment(accessToken, commentId, replyText) {
  try {
    // Validate token
    if (!accessToken || accessToken.includes("undefined") || accessToken.includes("null")) {
      throw new Error("Invalid access token format")
    }

    const response = await fetch(
      `https://graph.facebook.com/v18.0/${commentId}/replies?message=${encodeURIComponent(replyText)}&access_token=${accessToken}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
      },
    )

    if (!response.ok) {
      const errorData = await response.json()
      throw new Error(`Failed to reply to comment: ${JSON.stringify(errorData)}`)
    }

    return await response.json()
  } catch (error) {
    console.error("Error replying to comment:", error)
    throw error
  }
}

// Send a direct message
async function sendDirectMessage(accessToken, instagramAccountId, recipientUsername, message) {
  try {
    // Validate token
    if (!accessToken || accessToken.includes("undefined") || accessToken.includes("null")) {
      throw new Error("Invalid access token format")
    }

    let recipientId = null

    // Try multiple approaches to get the user ID
    try {
      // First try the username search endpoint
      const userSearchResponse = await fetch(
        `https://graph.facebook.com/v18.0/ig_username_search?q=${recipientUsername}&access_token=${accessToken}`,
        { cache: "no-store" },
      )

      if (userSearchResponse.ok) {
        const userSearchData = await userSearchResponse.json()
        if (userSearchData.data && userSearchData.data.length > 0) {
          recipientId = userSearchData.data[0].id
        }
      } else {
        console.log(`Username search failed for ${recipientUsername}, trying alternative method`)
      }
    } catch (searchError) {
      console.error(`Error searching for username ${recipientUsername}:`, searchError)
    }

    // If username search failed, try business discovery
    if (!recipientId) {
      try {
        const businessDiscoveryResponse = await fetch(
          `https://graph.facebook.com/v18.0/${instagramAccountId}?fields=business_discovery.username(${recipientUsername})&access_token=${accessToken}`,
          { cache: "no-store" },
        )

        if (businessDiscoveryResponse.ok) {
          const businessData = await businessDiscoveryResponse.json()
          if (businessData.business_discovery && businessData.business_discovery.id) {
            recipientId = businessData.business_discovery.id
          }
        }
      } catch (businessError) {
        console.error(`Error using business discovery for ${recipientUsername}:`, businessError)
      }
    }

    // If we still don't have a recipient ID, try one more approach
    if (!recipientId) {
      try {
        // Try to get user info from mentions
        const mentionsResponse = await fetch(
          `https://graph.facebook.com/v18.0/${instagramAccountId}/mentions?access_token=${accessToken}`,
          { cache: "no-store" },
        )

        if (mentionsResponse.ok) {
          const mentionsData = await mentionsResponse.json()
          const mention = mentionsData.data?.find((m) => m.username?.toLowerCase() === recipientUsername.toLowerCase())

          if (mention && mention.id) {
            recipientId = mention.id
          }
        }
      } catch (mentionsError) {
        console.error(`Error with mentions approach for ${recipientUsername}:`, mentionsError)
      }
    }

    // If we still don't have a recipient ID, throw an error
    if (!recipientId) {
      throw new Error(`Could not find Instagram user ID for @${recipientUsername}`)
    }

    // Now send the DM using the Instagram Graph API
    const dmResponse = await fetch(`https://graph.facebook.com/v18.0/${instagramAccountId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text: message },
        access_token: accessToken,
      }),
      cache: "no-store",
    })

    if (!dmResponse.ok) {
      const errorData = await dmResponse.json()
      throw new Error(`Failed to send direct message: ${JSON.stringify(errorData)}`)
    }

    return await dmResponse.json()
  } catch (error) {
    console.error("Error sending direct message:", error)
    throw error
  }
}

// Send a direct message with a button
async function sendDirectMessageWithButton(
  accessToken,
  instagramAccountId,
  recipientUsername,
  message,
  buttonText,
  automationId,
) {
  try {
    // Validate token
    if (!accessToken || accessToken.includes("undefined") || accessToken.includes("null")) {
      throw new Error("Invalid access token format")
    }

    let recipientId = null

    // Try multiple approaches to get the user ID
    try {
      // First try the username search endpoint
      const userSearchResponse = await fetch(
        `https://graph.facebook.com/v18.0/ig_username_search?q=${recipientUsername}&access_token=${accessToken}`,
        { cache: "no-store" },
      )

      if (userSearchResponse.ok) {
        const userSearchData = await userSearchResponse.json()
        if (userSearchData.data && userSearchData.data.length > 0) {
          recipientId = userSearchData.data[0].id
        }
      } else {
        console.log(`Username search failed for ${recipientUsername}, trying alternative method`)
      }
    } catch (searchError) {
      console.error(`Error searching for username ${recipientUsername}:`, searchError)
    }

    // If username search failed, try business discovery
    if (!recipientId) {
      try {
        const businessDiscoveryResponse = await fetch(
          `https://graph.facebook.com/v18.0/${instagramAccountId}?fields=business_discovery.username(${recipientUsername})&access_token=${accessToken}`,
          { cache: "no-store" },
        )

        if (businessDiscoveryResponse.ok) {
          const businessData = await businessDiscoveryResponse.json()
          if (businessData.business_discovery && businessData.business_discovery.id) {
            recipientId = businessData.business_discovery.id
          }
        }
      } catch (businessError) {
        console.error(`Error using business discovery for ${recipientUsername}:`, businessError)
      }
    }

    // If we still don't have a recipient ID, try one more approach
    if (!recipientId) {
      try {
        // Try to get user info from mentions
        const mentionsResponse = await fetch(
          `https://graph.facebook.com/v18.0/${instagramAccountId}/mentions?access_token=${accessToken}`,
          { cache: "no-store" },
        )

        if (mentionsResponse.ok) {
          const mentionsData = await mentionsResponse.json()
          const mention = mentionsData.data?.find((m) => m.username?.toLowerCase() === recipientUsername.toLowerCase())

          if (mention && mention.id) {
            recipientId = mention.id
          }
        }
      } catch (mentionsError) {
        console.error(`Error with mentions approach for ${recipientUsername}:`, mentionsError)
      }
    }

    // If we still don't have a recipient ID, throw an error
    if (!recipientId) {
      throw new Error(`Could not find Instagram user ID for @${recipientUsername}`)
    }

    // Now send the DM with button using the Instagram Graph API
    const dmResponse = await fetch(`https://graph.facebook.com/v18.0/${instagramAccountId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: {
          text: message,
          quick_replies: [
            {
              content_type: "text",
              title: buttonText,
              payload: `SEND_CONTENT_${automationId}`,
            },
          ],
        },
        access_token: accessToken,
      }),
      cache: "no-store",
    })

    if (!dmResponse.ok) {
      const errorData = await dmResponse.json()
      throw new Error(`Failed to send direct message: ${JSON.stringify(errorData)}`)
    }

    return await dmResponse.json()
  } catch (error) {
    console.error("Error sending direct message with button:", error)
    throw error
  }
}

// Send a direct message with fallback to comment reply
async function sendDirectMessageWithFallback(
  accessToken,
  instagramAccountId,
  recipientUsername,
  message,
  commentId = null,
) {
  try {
    // Validate token
    if (!accessToken || accessToken.includes("undefined") || accessToken.includes("null")) {
      throw new Error("Invalid access token format")
    }

    let recipientId = null

    // Try multiple approaches to get the user ID
    try {
      // First try the username search endpoint
      const userSearchResponse = await fetch(
        `https://graph.facebook.com/v18.0/ig_username_search?q=${recipientUsername}&access_token=${accessToken}`,
        { cache: "no-store" },
      )

      if (userSearchResponse.ok) {
        const userSearchData = await userSearchResponse.json()
        if (userSearchData.data && userSearchData.data.length > 0) {
          recipientId = userSearchData.data[0].id
        }
      } else {
        console.log(`Username search failed for ${recipientUsername}, trying alternative method`)
      }
    } catch (searchError) {
      console.error(`Error searching for username ${recipientUsername}:`, searchError)
    }

    // If username search failed, try business discovery
    if (!recipientId) {
      try {
        const businessDiscoveryResponse = await fetch(
          `https://graph.facebook.com/v18.0/${instagramAccountId}?fields=business_discovery.username(${recipientUsername})&access_token=${accessToken}`,
          { cache: "no-store" },
        )

        if (businessDiscoveryResponse.ok) {
          const businessData = await businessDiscoveryResponse.json()
          if (businessData.business_discovery && businessData.business_discovery.id) {
            recipientId = businessData.business_discovery.id
          }
        }
      } catch (businessError) {
        console.error(`Error using business discovery for ${recipientUsername}:`, businessError)
      }
    }

    // If we still don't have a recipient ID, try one more approach
    if (!recipientId) {
      try {
        // Try to get user info from mentions
        const mentionsResponse = await fetch(
          `https://graph.facebook.com/v18.0/${instagramAccountId}/mentions?access_token=${accessToken}`,
          { cache: "no-store" },
        )

        if (mentionsResponse.ok) {
          const mentionsData = await mentionsResponse.json()
          const mention = mentionsData.data?.find((m) => m.username?.toLowerCase() === recipientUsername.toLowerCase())

          if (mention && mention.id) {
            recipientId = mention.id
          }
        }
      } catch (mentionsError) {
        console.error(`Error with mentions approach for ${recipientUsername}:`, mentionsError)
      }
    }

    // If we still don't have a recipient ID, try direct ID approach
    if (!recipientId && /^\d+$/.test(recipientUsername)) {
      // If the username is all digits, try using it directly as an ID
      recipientId = recipientUsername
    }

    // If we have a recipient ID, try to send the DM
    if (recipientId) {
      try {
        // Now send the DM using the Instagram Graph API
        const dmResponse = await fetch(`https://graph.facebook.com/v18.0/${instagramAccountId}/messages`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            recipient: { id: recipientId },
            message: { text: message },
            access_token: accessToken,
          }),
          cache: "no-store",
        })

        if (dmResponse.ok) {
          return {
            success: true,
            method: "dm",
            response: await dmResponse.json(),
          }
        } else {
          const errorData = await dmResponse.json()
          console.error(`DM API error: ${JSON.stringify(errorData)}`)
          throw new Error(`Failed to send direct message: ${JSON.stringify(errorData)}`)
        }
      } catch (dmError) {
        console.error(`Error sending DM to ${recipientUsername}:`, dmError)

        // If we have a comment ID, try to reply to the comment as fallback
        if (commentId) {
          return await replyToCommentWithFallback(accessToken, commentId, message)
        } else {
          throw dmError
        }
      }
    } else if (commentId) {
      // If we couldn't get a recipient ID but have a comment ID, use comment reply as fallback
      return await replyToCommentWithFallback(accessToken, commentId, message)
    } else {
      throw new Error(`Could not find Instagram user ID for @${recipientUsername}`)
    }
  } catch (error) {
    console.error("Error in sendDirectMessageWithFallback:", error)
    throw error
  }
}

// Reply to a comment with fallback message
async function replyToCommentWithFallback(accessToken, commentId, message) {
  try {
    // Validate token
    if (!accessToken || accessToken.includes("undefined") || accessToken.includes("null")) {
      throw new Error("Invalid access token format")
    }

    // Format the message for a comment (shorter, no formatting)
    let commentMessage = message

    // Truncate if too long
    if (commentMessage.length > 300) {
      commentMessage = commentMessage.substring(0, 297) + "..."
    }

    // Remove any branding or formatting that wouldn't work well in comments
    commentMessage = commentMessage.replace(/⚡ Sent via ChatAutoDM.*$/m, "")

    const response = await fetch(
      `https://graph.facebook.com/v18.0/${commentId}/replies?message=${encodeURIComponent(commentMessage)}&access_token=${accessToken}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
      },
    )

    if (!response.ok) {
      const errorData = await response.json()
      throw new Error(`Failed to reply to comment: ${JSON.stringify(errorData)}`)
    }

    return {
      success: true,
      method: "comment_reply",
      response: await response.json(),
    }
  } catch (error) {
    console.error("Error replying to comment with fallback:", error)
    throw error
  }
}

// Scheduled job to check for comments
async function checkForComments() {
  try {
    console.log("Running scheduled job to check for comments")

    // Get all active automations
    const automations = await db
      .collection("automations")
      .find({
        active: true,
      })
      .toArray()

    console.log(`Found ${automations.length} active automations`)

    const totalProcessed = 0
    const totalSent = 0

    for (const automation of automations) {
      try {
        // Get the Instagram account
        const instagramAccount = await db.collection("instagramAccounts").findOne({
          _id: automation.instagramAccountId,
        })

        if (!instagramAccount) {
          console.log(`Instagram account ${automation.instagramAccountId} not found for automation ${automation._id}`)
          continue
        }

        // Validate token before using
        if (
          !instagramAccount.accessToken ||
          instagramAccount.accessToken.includes("undefined") ||
          instagramAccount.accessToken.includes("null")
        ) {
          console.log(`Invalid token format for account ${instagramAccount.username}, skipping automation`)
          continue
        }

        // Get a valid token
        const validToken = instagramAccount.pageAccessToken || instagramAccount.accessToken

        if (!validToken) {
          console.log(`No valid token for Instagram account ${instagramAccount.username}`)
          continue
        }

        // For "any post" automations, check all posts from this account
        if (!automation.postId) {
          console.log(`Processing "any post" automation ${automation._id}`)

          // Get all posts for this account
          const posts = await db.collection("posts").find({ instagramAccountId: instagramAccount._id }).toArray()

          console.log(`Found ${posts.length} posts for account ${instagramAccount._id}`)

          for (const post of posts) {
            await processPostComments(validToken, post, automation, instagramAccount)
          }

          continue
        }

        // Get the post
        const post = await db.collection("posts").findOne({
          _id: automation.postId,
        })

        if (!post) {
          console.log(`Post ${automation.postId} not found for automation ${automation._id}`)
          continue
        }

        await processPostComments(validToken, post, automation, instagramAccount)

        // Update the last checked time
        await db.collection("automations").updateOne({ _id: automation._id }, { $set: { lastChecked: new Date() } })
      } catch (error) {
        console.error(`Error processing automation ${automation._id}:`, error)
      }
    }

    console.log("Finished checking for comments")
  } catch (error) {
    console.error("Error checking for comments:", error)
  }
}

// Process comments for a post
async function processPostComments(accessToken, post, automation, instagramAccount) {
  try {
    // Validate token before using
    if (!accessToken || accessToken.includes("undefined") || accessToken.includes("null")) {
      console.log(`Invalid token format for post ${post.instagramId}, skipping`)
      return
    }

    // Get the last check time
    const lastChecked = automation.lastChecked || new Date(0)

    // Get comments for this post
    const comments = await getPostComments(accessToken, post.instagramId, lastChecked.toISOString())

    console.log(`Found ${comments.length} comments for post ${post.instagramId}`)

    // Process each comment
    for (const comment of comments) {
      try {
        // Check if we've already processed this comment
        const existingComment = await db.collection("comments").findOne({ commentId: comment.id })

        if (existingComment && existingComment.processed) {
          continue
        }

        // Process the comment
        await processComment({
          id: comment.id,
          text: comment.text || "",
          media_id: post.instagramId,
          from: {
            id: comment.from?.id || "unknown",
            username: comment.from?.username || comment.username || "unknown",
          },
        })
      } catch (commentError) {
        console.error(`Error processing comment ${comment.id}:`, commentError)
      }
    }
  } catch (error) {
    console.error(`Error processing post comments for post ${post.instagramId}:`, error)
  }
}

// Get comments for a post
async function getPostComments(accessToken, postId, since) {
  try {
    // Validate token before using
    if (!accessToken || accessToken.includes("undefined") || accessToken.includes("null")) {
      throw new Error("Invalid access token format")
    }

    const url = `https://graph.facebook.com/v18.0/${postId}/comments?fields=id,text,username,timestamp,from&access_token=${accessToken}&limit=50${since ? `&since=${since}` : ""}`

    const response = await fetch(url, { cache: "no-store" })

    if (!response.ok) {
      const errorData = await response.json()
      console.error("Instagram API error:", errorData)
      throw new Error(`Failed to fetch post comments: ${JSON.stringify(errorData)}`)
    }

    const data = await response.json()

    return data.data.map((comment) => ({
      id: comment.id,
      text: comment.text || "",
      username: comment.username || comment.from?.username || "unknown",
      timestamp: comment.timestamp,
      from: comment.from || { id: "unknown", username: comment.username || "unknown" },
    }))
  } catch (error) {
    console.error("Error fetching post comments:", error)
    return []
  }
}

// Scheduled job to refresh tokens
async function refreshTokens() {
  try {
    console.log("Running scheduled job to refresh tokens")

    // Get all Instagram accounts
    const accounts = await db.collection("instagramAccounts").find({}).toArray()

    console.log(`Found ${accounts.length} Instagram accounts`)

    for (const account of accounts) {
      try {
        // Skip accounts with invalid token format
        if (!account.accessToken || account.accessToken.includes("undefined") || account.accessToken.includes("null")) {
          console.log(`Invalid token format for account ${account.username}, marking for reconnection`)

          // Mark the account as needing reconnection
          await db.collection("instagramAccounts").updateOne(
            { _id: account._id },
            {
              $set: {
                tokenError: "Invalid token format",
                tokenErrorAt: new Date(),
                needsReconnection: true,
              },
            },
          )
          continue
        }

        // Check if token is expired or will expire soon (within 7 days)
        const now = new Date()
        const expiryDate = account.expiresAt ? new Date(account.expiresAt) : null
        const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)

        // If token doesn't expire or expiry is more than 7 days away, skip
        if (!expiryDate || expiryDate > sevenDaysFromNow) {
          continue
        }

        console.log(`Refreshing token for Instagram account: ${account.username} (expires: ${expiryDate})`)

        // Refresh the long-lived token
        const response = await fetch(
          `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${account.accessToken}`,
          { cache: "no-store" },
        )

        if (!response.ok) {
          const errorData = await response.json()
          console.error(`Failed to refresh token for ${account.username}:`, errorData)

          // Log the error
          await db.collection("tokenRefreshErrors").insertOne({
            accountId: account._id,
            username: account.username,
            error: errorData,
            timestamp: new Date(),
          })

          // Mark the account as needing reconnection
          await db.collection("instagramAccounts").updateOne(
            { _id: account._id },
            {
              $set: {
                tokenError: "Failed to refresh token automatically",
                tokenErrorAt: new Date(),
                needsReconnection: true,
              },
            },
          )

          continue
        }

        const data = await response.json()

        // Calculate new expiry date
        const newExpiryDate = new Date()
        newExpiryDate.setSeconds(newExpiryDate.getSeconds() + data.expires_in)

        // Update the account with new token and expiry
        await db.collection("instagramAccounts").updateOne(
          { _id: account._id },
          {
            $set: {
              accessToken: data.access_token,
              expiresAt: newExpiryDate,
              lastTokenRefresh: new Date(),
              needsReconnection: false,
              tokenError: null,
              tokenErrorAt: null,
            },
          },
        )

        console.log(`Successfully refreshed token for ${account.username}, new expiry: ${newExpiryDate}`)

        // Also update page access token if available
        if (account.pageId && account.pageAccessToken) {
          try {
            const pageTokenResponse = await fetch(
              `https://graph.facebook.com/${account.pageId}?fields=access_token&access_token=${data.access_token}`,
              { cache: "no-store" },
            )

            if (pageTokenResponse.ok) {
              const pageData = await pageTokenResponse.json()

              if (pageData.access_token) {
                await db.collection("instagramAccounts").updateOne(
                  { _id: account._id },
                  {
                    $set: {
                      pageAccessToken: pageData.access_token,
                    },
                  },
                )

                console.log(`Updated page access token for ${account.username}`)

                // Re-subscribe to webhooks with the new token
                try {
                  await subscribeToWebhooks(account.pageId, pageData.access_token)
                  console.log(`Re-subscribed to webhooks for ${account.username}`)
                } catch (webhookError) {
                  console.error(`Error re-subscribing to webhooks for ${account.username}:`, webhookError)
                }
              }
            }
          } catch (error) {
            console.error(`Error refreshing page token for ${account.username}:`, error)
          }
        }
      } catch (error) {
        console.error(`Error processing account ${account.username}:`, error)
      }
    }

    console.log("Finished refreshing tokens")
  } catch (error) {
    console.error("Error refreshing tokens:", error)
  }
}

// Function to subscribe to webhooks
async function subscribeToWebhooks(pageId, pageAccessToken) {
  try {
    const webhookUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/webhooks/instagram`

    // Subscribe to Instagram comments and messages
    const response = await fetch(`https://graph.facebook.com/v18.0/${pageId}/subscribed_apps`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        subscribed_fields: ["feed", "comments", "messages"],
        callback_url: webhookUrl,
        verify_token: process.env.WEBHOOK_VERIFY_TOKEN,
        access_token: pageAccessToken,
      }),
    })

    if (!response.ok) {
      const errorData = await response.json()
      throw new Error(`Failed to subscribe to webhooks: ${JSON.stringify(errorData)}`)
    }

    return await response.json()
  } catch (error) {
    console.error("Error subscribing to webhooks:", error)
    throw error
  }
}

// Schedule jobs
function scheduleJobs() {
  // Check for comments every 5 minutes
  setInterval(checkForComments, 1 * 60 * 1000)

  // Refresh tokens every 24 hours
  setInterval(refreshTokens, 24 * 60 * 60 * 1000)

  console.log("Scheduled jobs initialized")
}

// Start the server
async function startServer() {
  try {
    await connectToMongoDB()

    // Schedule jobs
    scheduleJobs()

    // Run initial jobs
    setTimeout(refreshTokens, 5000)
    setTimeout(checkForComments, 10000)

    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`)
    })
  } catch (error) {
    console.error("Error starting server:", error)
    process.exit(1)
  }
}

// Handle graceful shutdown
process.on("SIGTERM", async () => {
  console.log("SIGTERM received, shutting down gracefully")
  if (client) {
    await client.close()
    console.log("MongoDB connection closed")
  }
  process.exit(0)
})

// Start the server
startServer()
