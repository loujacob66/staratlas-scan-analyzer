require('dotenv').config();
const { Connection, PublicKey } = require('@solana/web3.js');
const { GmClientService } = require('@staratlas/factory');

const QUICKNODE_RPC_URL = process.env.QUICKNODE_RPC_URL;
if (!QUICKNODE_RPC_URL) {
  console.error("❌ QuickNode RPC URL is missing! Add it to your .env file.");
  process.exit(1);
}

const connection = new Connection(QUICKNODE_RPC_URL, 'confirmed');
const programId = new PublicKey('traderDnaR5w6Tcoi3NFm53i48FTDNbGjBSZwWXDRrg');
const sduMintAddress = new PublicKey('SDUsgfSZaDhhZ76U3ZgvtFiXsfnHbf2VrzYxjBZ5YbM');
const atlasMintAddress = new PublicKey('ATLASXmbPQxBUYbxPsV97usA3fPQYEqzQBUHgiFCUsXx');
const gmClientService = new GmClientService();

async function getLowestSDUPrice() {
  try {
    const allOrders = await gmClientService.getAllOpenOrders(connection, programId);
    const sduOrders = allOrders
      .filter(order => order.orderType === "sell")
      .filter(order => new PublicKey(order.orderMint).equals(sduMintAddress))
      .filter(order => new PublicKey(order.currencyMint).equals(atlasMintAddress))
      .filter(order => order.uiPrice >= 0.01)
      .sort((a, b) => a.uiPrice - b.uiPrice);

    if (sduOrders.length === 0) {
      return { price: null, quantity: null, seller: null };
    }

    const lowestOrder = sduOrders[0];
    return {
      price: parseFloat(lowestOrder.uiPrice).toFixed(6),
      quantity: lowestOrder.orderOriginationQty || "Unknown",
      seller: lowestOrder.owner,
    };
  } catch (error) {
    console.error("❌ Error fetching SDU price:", error.message);
    return { price: null, quantity: null, seller: null };
  }
}

module.exports = { getLowestSDUPrice };

// If you want to run this script directly, call the function
if (require.main === module) {
  getLowestSDUPrice().then(result => {
    console.log("\n🎯 Lowest SDU Listing:");
    console.log(`Price: ${result.price} ATLAS`);
    console.log(`Quantity: ${result.quantity}`);
    console.log(`Seller: ${result.seller}`);
  });
}
