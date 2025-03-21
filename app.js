require('dotenv').config();
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const axios = require('axios');
const { App } = require('@slack/bolt');
const { getLowestSDUPrice } = require('./sdu_price');

// 1. Build a mapping of fleet rental prices from environment variables
function buildRentalPricesFromEnv(prefix = "RENTAL_") {
  const rentalPrices = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith(prefix)) {
      const fleetName = key
        .slice(prefix.length)
        .split('_')
        .map(word => word.toLowerCase())
        .join(' ');
      rentalPrices[fleetName] = value;
    }
  }
  return rentalPrices;
}

const rentalPrices = buildRentalPricesFromEnv();

// 2. Lookup function for rental cost
function getRentalCost(fleet) {
  const normalizedFleet = fleet.toLowerCase().trim();
  if (normalizedFleet.includes("lemon")) {
    return "N/A";
  }
  return rentalPrices[normalizedFleet] || "N/A";
}

// 3. Fetch current ATLAS→USD conversion from CoinGecko
async function getAtlasUsdPrice() {
  const url = "https://api.coingecko.com/api/v3/simple/price?ids=star-atlas&vs_currencies=usd";
  try {
    const response = await axios.get(url);
    if (response.data && response.data["star-atlas"] && response.data["star-atlas"].usd) {
      return parseFloat(response.data["star-atlas"].usd);
    } else {
      throw new Error("Invalid data from CoinGecko");
    }
  } catch (err) {
    console.error("Error fetching ATLAS USD price:", err);
    // Fallback
    return 0.0013;
  }
}

// 4. Format the main fleet table in a code block
function formatFleetTable(tableData, hours) {
  const heading = `SDU Breakdown (Last ${hours}h):\n`;
  const headers = ["Fleet", "SDUs", "Val", "24h SDUs", "24h Val", "Rent", "ROI"];

  // Determine column widths
  const colWidths = headers.map(h => h.length);
  tableData.forEach(row => {
    headers.forEach((header, i) => {
      const cell = String(row[header]);
      if (cell.length > colWidths[i]) {
        colWidths[i] = cell.length;
      }
    });
  });

  // Header row + separator
  const headerRow = headers.map((h, i) => h.padEnd(colWidths[i])).join("   ");
  const separatorRow = colWidths.map(w => "-".repeat(w)).join("   ");
  
  // Data rows
  const rows = tableData.map(row => {
    return headers.map((header, i) => String(row[header]).padEnd(colWidths[i])).join("   ");
  });

  const tableString = [headerRow, separatorRow, ...rows].join("\n");
  return `\`\`\`\n${heading}${tableString}\n\`\`\``;
}

// 5. Create a single summary table for net profits in ATLAS & USD
// Rows in order: Rented, Owned, Overall
function formatNetProfitSummary(
  net24h, netDynamic,
  netRented24h, netRentedDynamic,
  netOwned24h, netOwnedDynamic,
  hours,
  atlasUsd
) {
  // Convert to USD
  const netUsd24h = net24h * atlasUsd;
  const netUsdDynamic = netDynamic * atlasUsd;

  const rentedUsd24h = netRented24h * atlasUsd;
  const rentedUsdDynamic = netRentedDynamic * atlasUsd;

  const ownedUsd24h = netOwned24h * atlasUsd;
  const ownedUsdDynamic = netOwnedDynamic * atlasUsd;

  // We'll have columns: Category, 24h(ATLAS), 24h(USD), Last Xh(ATLAS), Last Xh(USD)
  const headers = [
    "Category",
    "24h(ATLAS)",
    "24h(USD)",
    `Last ${hours}h(ATLAS)`,
    `Last ${hours}h(USD)`
  ];

  // Rows in the order: Rented, Owned, Overall
  const rowsData = [
    {
      Category: "Rented",
      "24h(ATLAS)": netRented24h.toFixed(2),
      "24h(USD)": (rentedUsd24h).toFixed(2),
      [`Last ${hours}h(ATLAS)`]: netRentedDynamic.toFixed(2),
      [`Last ${hours}h(USD)`]: rentedUsdDynamic.toFixed(2),
    },
    {
      Category: "Owned",
      "24h(ATLAS)": netOwned24h.toFixed(2),
      "24h(USD)": (ownedUsd24h).toFixed(2),
      [`Last ${hours}h(ATLAS)`]: netOwnedDynamic.toFixed(2),
      [`Last ${hours}h(USD)`]: ownedUsdDynamic.toFixed(2),
    },
    {
      Category: "Overall",
      "24h(ATLAS)": net24h.toFixed(2),
      "24h(USD)": netUsd24h.toFixed(2),
      [`Last ${hours}h(ATLAS)`]: netDynamic.toFixed(2),
      [`Last ${hours}h(USD)`]: netUsdDynamic.toFixed(2),
    }
  ];

  // Determine column widths
  const colWidths = headers.map(h => h.length);
  rowsData.forEach(row => {
    headers.forEach((header, i) => {
      const cell = String(row[header]);
      if (cell.length > colWidths[i]) {
        colWidths[i] = cell.length;
      }
    });
  });

  // Build header + separator
  const headerRow = headers.map((h, i) => h.padEnd(colWidths[i])).join("   ");
  const separatorRow = colWidths.map(w => "-".repeat(w)).join("   ");

  // Build data rows
  const dataRows = rowsData.map(row => {
    return headers.map((header, i) => {
      return String(row[header]).padEnd(colWidths[i]);
    }).join("   ");
  });

  const tableString = [headerRow, separatorRow, ...dataRows].join("\n");
  return `\`\`\`\nNet Profits:\n${tableString}\n\`\`\``;
}

// 6. Build final Slack message with the main fleet table + single summary table
function buildSlackMessage(
  fleetTableString,
  net24h,
  netDynamic,
  netRented24h,
  netRentedDynamic,
  netOwned24h,
  netOwnedDynamic,
  hours,
  atlasUsd
) {
  const summaryTable = formatNetProfitSummary(
    net24h, netDynamic,
    netRented24h, netRentedDynamic,
    netOwned24h, netOwnedDynamic,
    hours,
    atlasUsd
  );
  return [fleetTableString, summaryTable].join("\n\n");
}

// 7. Aggregates CSV data, calculates net profits, returns final Slack message
function analyzeAndFormatMessage(csvFilePath, hours = 24) {
  return new Promise((resolve, reject) => {
    let fleetDataDynamic = {}; // for user-specified window
    let fleetData24h = {};     // fixed 24h

    const now = new Date();
    const startTimeDynamic = new Date(now.getTime() - hours * 60 * 60 * 1000);
    const startTime24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    fs.createReadStream(csvFilePath)
      .pipe(csv())
      .on('data', row => {
        if (!row['Timestamp']) return;
        let timestamp = new Date(row['Timestamp']);
        if (isNaN(timestamp)) {
          try {
            const formattedTimestamp = row['Timestamp']
              .replace(/-/g, "/")
              .replace(" ", "T");
            timestamp = new Date(formattedTimestamp);
          } catch (e) {
            return;
          }
        }
        if (isNaN(timestamp)) return;

        const fleet = row['Fleet Name'] ? row['Fleet Name'].trim() : "Unknown";
        const sduFound = parseInt(row['SDU Count'], 10) || 0;

        // If within user-specified window
        if (timestamp >= startTimeDynamic) {
          fleetDataDynamic[fleet] = (fleetDataDynamic[fleet] || 0) + sduFound;
        }
        // If within last 24h
        if (timestamp >= startTime24h) {
          fleetData24h[fleet] = (fleetData24h[fleet] || 0) + sduFound;
        }
      })
      .on('end', async () => {
        try {
          const { price } = await getLowestSDUPrice();
          if (!price) return reject("No valid SDU price found.");
          const currentPrice = parseFloat(price);

          const atlasUsdPrice = await getAtlasUsdPrice(); // from CoinGecko
          const usdRate = atlasUsdPrice || 0.0013;        // fallback

          // Combine fleets
          const allFleets = new Set([
            ...Object.keys(fleetDataDynamic),
            ...Object.keys(fleetData24h)
          ]);

          let totalValDynamic = 0, totalVal24h = 0;
          let totalRentDynamic = 0, totalRent24h = 0;
          let rentedValDynamic = 0, rentedVal24h = 0;
          let rentedRentDynamic = 0, rentedRent24h = 0;
          let ownedValDynamic = 0, ownedVal24h = 0;

          const tableData = [];
          allFleets.forEach(fleet => {
            const dynamicCount = fleetDataDynamic[fleet] || 0;
            const valueDynamic = dynamicCount * currentPrice;

            const count24h = fleetData24h[fleet] || 0;
            const value24h = count24h * currentPrice;

            const rentStr = getRentalCost(fleet);
            const rentNum = parseFloat(rentStr);
            let roi = "N/A";

            if (!isNaN(rentNum) && rentNum > 0) {
              const ratio = value24h / rentNum;
              roi = (ratio * 100).toFixed(0) + "%";
              totalRent24h += rentNum;
              const prorated = rentNum * (hours / 24);
              totalRentDynamic += prorated;

              rentedValDynamic += valueDynamic;
              rentedVal24h += value24h;
              rentedRentDynamic += prorated;
              rentedRent24h += rentNum;
            } else {
              ownedValDynamic += valueDynamic;
              ownedVal24h += value24h;
            }

            totalValDynamic += valueDynamic;
            totalVal24h += value24h;

            tableData.push({
              "Fleet": fleet,
              "SDUs": dynamicCount.toString(),
              "Val": valueDynamic.toFixed(2),
              "24h SDUs": count24h.toString(),
              "24h Val": value24h.toFixed(2),
              "Rent": rentStr,
              "ROI": roi
            });
          });

          const net24h = totalVal24h - totalRent24h;
          const netDynamic = totalValDynamic - totalRentDynamic;
          const netRented24h = rentedVal24h - rentedRent24h;
          const netRentedDynamic = rentedValDynamic - rentedRentDynamic;
          const netOwned24h = ownedVal24h; // no rent
          const netOwnedDynamic = ownedValDynamic;

          // Build the main fleet table
          const fleetTableString = formatFleetTable(tableData, hours);

          // Build the final Slack message with single summary table
          const finalMessage = buildSlackMessage(
            fleetTableString,
            net24h,
            netDynamic,
            netRented24h,
            netRentedDynamic,
            netOwned24h,
            netOwnedDynamic,
            hours,
            usdRate
          );
          resolve(finalMessage);
        } catch (err) {
          reject(err);
        }
      })
      .on('error', err => reject(err));
  });
}

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  port: process.env.PORT || 3000
});

// Slash command /scanners [hours?]
app.command("/scanners", async ({ command, ack, respond }) => {
  try {
    await ack();
    let hours = 24;
    if (command.text && command.text.trim().length > 0) {
      const parsed = parseInt(command.text.trim(), 10);
      if (!isNaN(parsed) && parsed > 0) {
        hours = parsed;
      }
    }

    const csvFilePath = process.env.CSV_FILE_PATH || path.join(__dirname, "scan_stats.csv");
    const message = await analyzeAndFormatMessage(csvFilePath, hours);

    await respond({
      response_type: "in_channel",
      text: message
    });
  } catch (error) {
    console.error("Error processing /scanners command:", error);
    await respond("Sorry, something went wrong while processing your request.");
  }
});

// Start the app
(async () => {
  await app.start();
  console.log(`⚡️ Slack bot is running on port ${process.env.PORT || 3000}!`);
})();
