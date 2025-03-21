require('dotenv').config();
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const axios = require('axios');
const { getLowestSDUPrice } = require('./sdu_price');

const CSV_FILE_PATH = process.env.CSV_FILE_PATH || "/mnt/star_atlas/scanning/scan_stats.csv";

// 1. Build rental prices mapping from .env
function loadRentalPrices() {
  const rentalPrices = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("RENTAL_")) {
      // e.g. RENTAL_PLANET_EATER becomes "planet eater"
      const fleetName = key.slice("RENTAL_".length)
        .split('_')
        .map(word => word.toLowerCase())
        .join(' ');
      rentalPrices[fleetName] = parseFloat(value);
    }
  }
  return rentalPrices;
}
const rentalPrices = loadRentalPrices();

function getRentalCost(fleet) {
  const normalizedFleet = fleet.toLowerCase().trim();
  return rentalPrices[normalizedFleet] ?? "N/A";
}

// 2. Fetch ATLAS-to-USD conversion rate from CoinGecko
async function getAtlasUsdPrice() {
  try {
    const response = await axios.get(
      "https://api.coingecko.com/api/v3/simple/price?ids=star-atlas&vs_currencies=usd"
    );
    return response.data["star-atlas"]?.usd || 0.0013;
  } catch (err) {
    console.error("Error fetching ATLAS USD price:", err);
    return 0.0013;
  }
}

// 3. Process CSV using correct column names: Timestamp, Fleet Name, SDU Count
async function processCSV(hours) {
  return new Promise((resolve, reject) => {
    const now = new Date();
    const since = new Date(now.getTime() - hours * 60 * 60 * 1000);
    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const fleetData = {};
    fs.createReadStream(CSV_FILE_PATH)
      .pipe(csv())
      .on('data', (row) => {
        if (!row.Timestamp || !row["Fleet Name"] || !row["SDU Count"]) return;
        const timestamp = new Date(row.Timestamp);
        if (isNaN(timestamp)) return;
        const fleet = row["Fleet Name"].trim();
        const sduCount = parseInt(row["SDU Count"], 10) || 0;
        if (!fleetData[fleet]) {
          fleetData[fleet] = { SDUs: 0, SDUs24h: 0 };
        }
        if (timestamp >= since) fleetData[fleet].SDUs += sduCount;
        if (timestamp >= last24h) fleetData[fleet].SDUs24h += sduCount;
      })
      .on('end', () => resolve(fleetData))
      .on('error', reject);
  });
}

// 4. Format the main fleet table as plain text (no backticks)
function formatFleetTable(fleetData, hours, price) {
  if (Object.keys(fleetData).length === 0) return `⚠️ No data for the last ${hours} hours.\n`;
  const headers = ["Fleet", "SDUs", "Val", "24h SDUs", "24h Val", "Rent", "ROI"];
  
  // Determine max width for each column
  const colWidths = headers.map(h => h.length);
  const rows = Object.entries(fleetData).map(([fleet, data]) => {
    const val = (data.SDUs * price).toFixed(2);
    const val24h = (data.SDUs24h * price).toFixed(2);
    const rent = getRentalCost(fleet);
    const roi = rent !== "N/A" && rent > 0 ? ((data.SDUs24h * price) / rent * 100).toFixed(0) + "%" : "N/A";
    const rowData = [fleet, data.SDUs, val, data.SDUs24h, val24h, rent, roi];
    rowData.forEach((cell, i) => {
      if (String(cell).length > colWidths[i]) colWidths[i] = String(cell).length;
    });
    return rowData;
  });
  
  const headerRow = headers.map((h, i) => h.padEnd(colWidths[i])).join("   ");
  const separatorRow = colWidths.map(w => "-".repeat(w)).join("   ");
  const dataRows = rows.map(row => row.map((cell, i) => String(cell).padEnd(colWidths[i])).join("   "));
  
  const tableString = [headerRow, separatorRow, ...dataRows].join("\n");
  return `SDU Breakdown (Last ${hours}h):\n` + tableString;
}

// 5. Format a single summary table for net profits (rented, owned, overall)
// Columns: Category, 24h(ATLAS), 24h(USD), Last Xh(ATLAS), Last Xh(USD), ROI
function formatNetProfitSummary(net24h, netDynamic, netRented24h, netRentedDynamic, netOwned24h, netOwnedDynamic, hours, atlasUsd, totalVal24h, totalRent24h, rentedVal24h, rentedRent24h) {
  const overallUsd24h = net24h * atlasUsd;
  const overallUsdDynamic = netDynamic * atlasUsd;
  const rentedUsd24h = netRented24h * atlasUsd;
  const rentedUsdDynamic = netRentedDynamic * atlasUsd;
  const ownedUsd24h = netOwned24h * atlasUsd;
  const ownedUsdDynamic = netOwnedDynamic * atlasUsd;

  // Compute ROI for Overall and Rented (Owned gets "N/A")
  const overallROI = totalRent24h > 0 ? ((totalVal24h / totalRent24h) * 100).toFixed(0) + "%" : "N/A";
  const rentedROI = rentedRent24h > 0 ? ((rentedVal24h / rentedRent24h) * 100).toFixed(0) + "%" : "N/A";

  const headers = ["Category", "24h(ATLAS)", "24h(USD)", `Last ${hours}h(ATLAS)`, `Last ${hours}h(USD)`, "ROI"];
  const rowsData = [
    { Category: "Rented", "24h(ATLAS)": netRented24h.toFixed(2), "24h(USD)": rentedUsd24h.toFixed(2), [`Last ${hours}h(ATLAS)`]: netRentedDynamic.toFixed(2), [`Last ${hours}h(USD)`]: rentedUsdDynamic.toFixed(2), ROI: rentedROI },
    { Category: "Owned", "24h(ATLAS)": netOwned24h.toFixed(2), "24h(USD)": ownedUsd24h.toFixed(2), [`Last ${hours}h(ATLAS)`]: netOwnedDynamic.toFixed(2), [`Last ${hours}h(USD)`]: ownedUsdDynamic.toFixed(2), ROI: "N/A" },
    { Category: "Overall", "24h(ATLAS)": net24h.toFixed(2), "24h(USD)": overallUsd24h.toFixed(2), [`Last ${hours}h(ATLAS)`]: netDynamic.toFixed(2), [`Last ${hours}h(USD)`]: overallUsdDynamic.toFixed(2), ROI: overallROI }
  ];

  // Determine column widths
  const colWidths = headers.map(h => h.length);
  rowsData.forEach(row => {
    headers.forEach((header, i) => {
      const cell = String(row[header]);
      if (cell.length > colWidths[i]) colWidths[i] = cell.length;
    });
  });
  
  const headerRow = headers.map((h, i) => h.padEnd(colWidths[i])).join("   ");
  const separatorRow = colWidths.map(w => "-".repeat(w)).join("   ");
  const dataRows = rowsData.map(row => headers.map((header, i) => String(row[header]).padEnd(colWidths[i])).join("   "));
  
  const tableString = [headerRow, separatorRow, ...dataRows].join("\n");
  return `Net Profits:\n` + tableString;
}

// 6. Build final message by combining fleet table and summary table
function buildFinalMessage(fleetTable, net24h, netDynamic, netRented24h, netRentedDynamic, netOwned24h, netOwnedDynamic, hours, atlasUsd, totalVal24h, totalRent24h, rentedVal24h, rentedRent24h) {
  const summaryTable = formatNetProfitSummary(net24h, netDynamic, netRented24h, netRentedDynamic, netOwned24h, netOwnedDynamic, hours, atlasUsd, totalVal24h, totalRent24h, rentedVal24h, rentedRent24h);
  return fleetTable + "\n\n" + summaryTable;
}

// 7. Aggregate CSV data and compute net profits
async function analyzeAndFormatLocal(hours = 24) {
  const fleetData = await processCSV(hours);
  const { price } = await getLowestSDUPrice();
  if (!price) throw new Error("No valid SDU price found.");
  const currentPrice = parseFloat(price);
  const atlasUsd = await getAtlasUsdPrice();

  // Prepare detailed fleet data and compute totals
  let totalValDynamic = 0, totalVal24h = 0;
  let totalRentDynamic = 0, totalRent24h = 0;
  let rentedValDynamic = 0, rentedVal24h = 0;
  let rentedRentDynamic = 0, rentedRent24h = 0;
  let ownedValDynamic = 0, ownedVal24h = 0;

  for (const [fleet, data] of Object.entries(fleetData)) {
    const valDynamic = data.SDUs * currentPrice;
    const val24h = data.SDUs24h * currentPrice;
    totalValDynamic += valDynamic;
    totalVal24h += val24h;

    const rent = getRentalCost(fleet);
    const rentNum = parseFloat(rent);
    if (!isNaN(rentNum) && rentNum > 0) {
      totalRent24h += rentNum;
      const prorated = rentNum * (hours / 24);
      totalRentDynamic += prorated;
      rentedValDynamic += valDynamic;
      rentedVal24h += val24h;
      rentedRentDynamic += prorated;
      rentedRent24h += rentNum;
    } else {
      ownedValDynamic += valDynamic;
      ownedVal24h += val24h;
    }
  }

  const net24h = totalVal24h - totalRent24h;
  const netDynamic = totalValDynamic - totalRentDynamic;
  const netRented24h = rentedVal24h - rentedRent24h;
  const netRentedDynamic = rentedValDynamic - rentedRentDynamic;
  const netOwned24h = ownedVal24h;
  const netOwnedDynamic = ownedValDynamic;

  const fleetTableString = formatFleetTable(fleetData, hours, currentPrice);
  return buildFinalMessage(fleetTableString, net24h, netDynamic, netRented24h, netRentedDynamic, netOwned24h, netOwnedDynamic, hours, atlasUsd, totalVal24h, totalRent24h, rentedVal24h, rentedRent24h);
}

// 8. Main entry: if "pushover" argument is given, send via Pushover; otherwise, print to stdout.
async function main() {
  const args = process.argv.slice(2);
  const mode = args[0] === "pushover" ? "pushover" : "stdout";
  const hours = (mode === "pushover" ? args[1] : args[0]) ? parseInt(mode === "pushover" ? args[1] : args[0], 10) || 24 : 24;

  try {
    const message = await analyzeAndFormatLocal(hours);
    if (mode === "pushover") {
      const pushoverToken = process.env.PUSHOVER_TOKEN;
      const pushoverUser = process.env.PUSHOVER_USER;
      if (!pushoverToken || !pushoverUser) {
        console.error("Pushover credentials missing. Outputting to stdout instead:");
        console.log(message);
        return;
      }
      await axios.post("https://api.pushover.net/1/messages.json", {
        token: pushoverToken,
        user: pushoverUser,
        message: message
      });
      console.log("Message sent to Pushover.");
    } else {
      console.log(message);
    }
  } catch (err) {
    console.error("Error analyzing data:", err);
  }
}

main();
