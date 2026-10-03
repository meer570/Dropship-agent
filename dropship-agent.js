import express from 'express';
import axios from 'axios';
import * as cheerio from 'cheerio';
import twilio from 'twilio';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());

// CONFIGURATION
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const WHATSAPP_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const WHATSAPP_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const WHATSAPP_FROM = process.env.WHATSAPP_FROM;
const WHATSAPP_TO = process.env.WHATSAPP_TO;
const TRUSTED_WEBSITE = process.env.TRUSTED_WEBSITE;
const PROFIT_MARGIN = parseFloat(process.env.PROFIT_MARGIN || 0.30);

const twilioClient = twilio(WHATSAPP_ACCOUNT_SID, WHATSAPP_AUTH_TOKEN);

// SHOPIFY API CALLS
async function getShopifyHeaders() {
  return {
    'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
    'Content-Type': 'application/json',
  };
}

async function createShopifyProduct(product) {
  try {
    const headers = await getShopifyHeaders();
    const url = `https://${SHOPIFY_STORE}/admin/api/2024-01/products.json`;
    
    const response = await axios.post(url, {
      product: {
        title: product.title,
        body_html: product.description,
        variants: [{
          price: product.price,
          sku: product.sku,
          inventory_quantity: 100,
        }],
        images: product.images.map(img => ({ src: img })),
      },
    }, { headers });

    console.log('Product added:', response.data.product.id);
    return response.data.product;
  } catch (error) {
    console.error('Shopify error:', error.message);
    throw error;
  }
}

// WEB SCRAPING FUNCTION
async function scrapeTrendingProducts() {
  try {
    console.log('Scraping products from:', TRUSTED_WEBSITE);
    
    const response = await axios.get(TRUSTED_WEBSITE, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      }
    });

    const $ = cheerio.load(response.data);
    const products = [];

    // Product selectors
    $('.product-item, [data-product], .product').each((index, element) => {
      if (products.length >= 15) return;

      try {
        const title = $(element).find('.product-title, .title, h2').text().trim();
        const priceText = $(element).find('.price, [data-price]').text().trim();
        const imageUrl = $(element).find('img').attr('src');
        const productUrl = $(element).find('a').attr('href');
        
        const originalPrice = parseFloat(priceText.replace(/[^\d.]/g, ''));

        if (title && originalPrice > 0 && imageUrl && productUrl) {
          const markupPrice = originalPrice * (1 + PROFIT_MARGIN);
          
          products.push({
            title: title.substring(0, 100),
            originalPrice: originalPrice,
            markupPrice: parseFloat(markupPrice.toFixed(2)),
            imageUrl: imageUrl.startsWith('http') ? imageUrl : TRUSTED_WEBSITE + imageUrl,
            productUrl: productUrl.startsWith('http') ? productUrl : TRUSTED_WEBSITE + productUrl,
            sku: `DROP-${Date.now()}-${Math.random()}`,
          });
        }
      } catch (err) {
        console.error('Parse error:', err.message);
      }
    });

    console.log('Found products:', products.length);
    return products;
  } catch (error) {
    console.error('Scraping error:', error.message);
    return [];
  }
}

// WHATSAPP MESSAGING
async function sendWhatsAppMessage(message) {
  try {
    const response = await twilioClient.messages.create({
      body: message,
      from: WHATSAPP_FROM,
      to: WHATSAPP_TO,
    });
    console.log('WhatsApp sent:', response.sid);
    return response.sid;
  } catch (error) {
    console.error('WhatsApp error:', error.message);
  }
}

async function notifyNewProducts(products) {
  let message = 'Naaye Trending Products!\n\n';
  
  products.slice(0, 5).forEach((product, index) => {
    message += `${index + 1}. ${product.title.substring(0, 50)}\n`;
    message += `Price: Rs ${product.markupPrice}\n`;
    message += `Link: ${product.productUrl}\n\n`;
  });
  
  message += `Total ${products.length} products added to your store!`;
  
  await sendWhatsAppMessage(message);
}

async function notifyNewOrder(order) {
  const message = `
NEW ORDER ALERT!

Order ID: #${order.id}
Customer: ${order.customer_name}
Amount: Rs ${order.total_price}
Email: ${order.email}

Product Source: ${order.source_link}

Status: ${order.financial_status}
  `;
  
  await sendWhatsAppMessage(message.trim());
}

// API ENDPOINTS
app.post('/api/sync-products', async (req, res) => {
  try {
    console.log('Sync started...');
    const products = await scrapeTrendingProducts();
    
    if (products.length === 0) {
      return res.status(400).json({ error: 'No products found' });
    }

    const syncedProducts = [];
    
    for (const product of products) {
      try {
        const shopifyProduct = await createShopifyProduct({
          title: product.title,
          description: `Original Price: Rs ${product.originalPrice}\nSource: ${product.productUrl}`,
          price: product.markupPrice,
          sku: product.sku,
          images: [product.imageUrl],
        });

        syncedProducts.push({
          id: shopifyProduct.id,
          title: shopifyProduct.title,
          price: product.markupPrice,
          sourceUrl: product.productUrl,
        });
      } catch (err) {
        console.error('Product sync error:', err.message);
      }
    }

    // Send notification
    if (syncedProducts.length > 0) {
      await notifyNewProducts(products);
    }

    res.json({
      success: true,
      synced: syncedProducts.length,
      total: products.length,
      products: syncedProducts,
    });
  } catch (error) {
    console.error('Sync error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// SHOPIFY ORDER WEBHOOK
app.post('/api/orders/webhook', async (req, res) => {
  try {
    const order = req.body;
    
    const orderData = {
      id: order.id,
      customer_name: `${order.customer?.first_name || ''} ${order.customer?.last_name || ''}`.trim(),
      email: order.customer?.email,
      total_price: order.total_price,
      financial_status: order.financial_status,
      source_link: order.note || 'Shopify Store',
    };

    console.log('New order received:', order.id);
    await notifyNewOrder(orderData);

    res.json({ success: true });
  } catch (error) {
    console.error('Webhook error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// MANUAL ORDER NOTIFICATION
app.post('/api/notify-order', async (req, res) => {
  try {
    const order = req.body;
    await notifyNewOrder(order);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// HEALTH CHECK
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    message: 'Dropship Agent is running'
  });
});

// AUTOMATIC SYNC - EVERY 6 HOURS
setInterval(async () => {
  console.log('Running scheduled sync...');
  try {
    const products = await scrapeTrendingProducts();
    
    if (products.length > 0) {
      for (const product of products.slice(0, 5)) {
        try {
          await createShopifyProduct({
            title: product.title,
            description: `Original Price: Rs ${product.originalPrice}`,
            price: product.markupPrice,
            sku: product.sku,
            images: [product.imageUrl],
          });
        } catch (err) {
          console.error('Auto-sync product error:', err.message);
        }
      }
      
      console.log('Scheduled sync completed');
      await sendWhatsAppMessage(`Scheduled sync: ${products.length} new products added!`);
    }
  } catch (error) {
    console.error('Scheduled sync error:', error.message);
  }
}, 6 * 60 * 60 * 1000);

// START SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Dropship Agent running on port ${PORT}`);
  console.log(`Server started at: ${new Date().toISOString()}`);
});

export default app;
