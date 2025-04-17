import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode-terminal';
import express from 'express';
import fetch from 'node-fetch';
import https from 'https';
const app = express();

// Configure fetch agent with proper SSL handling
const agent = new https.Agent({
    rejectUnauthorized: true,
    checkServerIdentity: (host, cert) => {
        // You can implement custom certificate validation here if needed
        return undefined; // Accept the certificate
    }
});

// Configure express to parse JSON
app.use(express.json());

// Initialize WhatsApp client
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox']
    }
});

// Generate QR code for WhatsApp Web authentication
client.on('qr', (qr) => {
    console.log('Scan the QR code below to login to WhatsApp Web:');
    qrcode.generate(qr, { small: true });
});

// Handle client ready event
client.on('ready', () => {
    console.log('Client is ready!');
});

// Handle incoming messages
client.on('message', async msg => {
    const chat = await msg.getChat();
    console.log(`New message from ${chat.name}: ${msg.body}`);

    // Forward message to n8n webhook (you'll need to set this up in n8n)
    const maxRetries = 3;
    let retryCount = 0;
    
    while (retryCount < maxRetries) {
        try {
            const response = await fetch('https://n8n.kav.co.id/webhook-test/whatsapp', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify({
                    message: msg.body,
                    from: msg.from,
                    timestamp: msg.timestamp
                }),
                agent: agent,
                timeout: 10000 // 10 seconds timeout to handle slower connections
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HTTP error! status: ${response.status}, message: ${errorText}`);
            }
            
            // Handle n8n response
            const data = await response.json();
            if (data.reply) {
                await msg.reply(data.reply);
            }
            break; // Success, exit the retry loop
        } catch (error) {
            retryCount++;
            console.error(`Attempt ${retryCount}/${maxRetries} - Error forwarding message to n8n:`, error);
            
            if (retryCount === maxRetries) {
                let errorMessage = 'Sorry, I am having trouble processing your message right now.';
                if (error.code === 'EPROTO' || error.code === 'ECONNREFUSED') {
                    errorMessage = 'Unable to establish a secure connection with the server. Please check the SSL configuration.';
                } else if (error.type === 'system') {
                    errorMessage = 'A system error occurred. Please try again later.';
                }
                await msg.reply(errorMessage);
                break;
            }
            
            // Wait before retrying (exponential backoff)
            await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, retryCount)));
        }
    }
});

// Initialize WhatsApp client
client.initialize();

// API endpoint for sending messages (can be triggered from n8n)
app.post('/send-message', async (req, res) => {
    try {
        const { to, message } = req.body;
        await client.sendMessage(to, message);
        res.json({ success: true });
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Start express server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});