require('dotenv').config();
const fs = require('fs');
const csv = require('csv-parser');
const axios = require('axios');
const { getLowestSDUPrice } = require('./sdu_price');

const CSV_FILE_PATH = process.env.CSV_FILE_PATH || "/mnt/star_atlas/scanning/scan_stats.csv";
const BASES_FILE_PATH = process.env.BASES_FILE_PATH || "./.bases"; // now looks in the local directory

const DEBUG = process.env.DEBUG_BASES === 'true';

// 1. Build rental prices mapping from .env
function loadRentalPrices() {
  const rentalPrices = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("RENTAL_")) {
      const fleetName = key
        .slice("RENTAL_".length)
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

// 2. Fetch current ATLAS-to-USD conversion rate from CoinGecko
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

// 3. Load bases mapping from the .bases file
function loadBasesMapping() {
  const content = fs.readFileSync(BASES_FILE_PATH, 'utf8');
  const mapping = {};
  const lines = content.split('\n').filter(line => line.trim());
  lines.forEach(line => {
    // Split on one or more whitespace or comma characters.
    const parts = line.trim().split(/[\s,]+/);
    if (parts.length >= 2) {
      const coord = parts[0].trim();
      const baseName = parts[1].trim();
      mapping[coord] = baseName;
    }
  });
  if (DEBUG) {
    console.log("Loaded bases mapping:", mapping);
  }
  return mapping;
}

// 4. Process CSV and reconcile the coordinate using the mapping
async function processCSV(hours, basesMapping) {
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
          fleetData[fleet] = { SDUs: 0, SDUs24h: 0, baseName: "" };
        }
        if (timestamp >= since) fleetData[fleet].SDUs += sduCount;
        if (timestamp >= last24h) fleetData[fleet].SDUs24h += sduCount;

        // Try to get the coordinate from either "Starbase Coordinate" or "Starbase"
        let starbaseKey = "";
        if (row["Starbase Coordinate"] && row["Starbase Coordinate"].trim() !== "") {
          starbaseKey = row["Starbase Coordinate"].trim();
        } else if (row["Starbase"] && row["Starbase"].trim() !== "") {
          starbaseKey = row["Starbase"].trim();
        }
        if (starbaseKey !== "") {
          const baseName = basesMapping[starbaseKey] || "Unknown";
          if (DEBUG) {
            console.log(`Row with key "${starbaseKey}" mapped to base name: "${baseName}"`);
          }
          fleetData[fleet].baseName = baseName;
        }
      })
      .on('end', () => resolve(fleetData))
      .on('error', reject);
  });
}

// 5. Format the fleet table with a new "Base" column that shows the base name,
// and sort the output alphabetically by base name.
function formatFleetTable(fleetData, hours, price) {
  if (Object.keys(fleetData).length === 0) {
    return `⚠️ No data for the last ${hours} hours.\n`;
  }
  const headers = ["Fleet", "Base", "SDUs", "Val", "24h SDUs", "24h Val", "Rent", "ROI"];
  const tableRows = [];
  tableRows.push(headers);

  // Convert fleetData to an array and sort by the baseName field alphabetically.
  const sortedEntries = Object.entries(fleetData).sort((a, b) => {
    const baseA = a[1].baseName || "";
    const baseB = b[1].baseName || "";
    return baseA.localeCompare(baseB);
  });

  sortedEntries.forEach(([fleet, data]) => {
    const valDynamic = (data.SDUs * price).toFixed(2);
    const val24h = (data.SDUs24h * price).toFixed(2);
    const rent = getRentalCost(fleet);
    let roi = "N/A";
    if (rent !== "N/A" && !isNaN(parseFloat(rent)) && parseFloat(rent) > 0) {
      roi = ((data.SDUs24h * price) / parseFloat(rent) * 100).toFixed(0) + "%";
    }
    tableRows.push([
      fleet,
      data.baseName || "",
      data.SDUs.toString(),
      valDynamic,
      data.SDUs24h.toString(),
      val24h,
      rent.toString(),
      roi
    ]);
  });

  const colWidths = headers.map((_, colIndex) => {
    let maxWidth = 0;
    tableRows.forEach(row => {
      const cellText = row[colIndex];
      if (cellText.length > maxWidth) {
        maxWidth = cellText.length;
      }
    });
    return maxWidth;
  });

  const separatorRow = colWidths.map(w => "-".repeat(w)).join("   ");
  const lines = [];
  lines.push(`SDU Breakdown (Last ${hours}h):`);
  tableRows.forEach((row, rowIndex) => {
    if (rowIndex === 1) {
      lines.push(separatorRow);
    }
    const line = row.map((cell, i) => cell.padEnd(colWidths[i])).join("   ");
    lines.push(line);
  });
  return lines.join("\n");
}

// Mobile formatting (includes the Base label and sorts by base name)
function formatFleetTableMobile(fleetData, hours, price) {
  if (Object.keys(fleetData).length === 0) return `No data for the last ${hours} hours.`;

  // Sort entries by baseName
  const sortedEntries = Object.entries(fleetData).sort((a, b) => {
    const baseA = a[1].baseName || "";
    const baseB = b[1].baseName || "";
    return baseA.localeCompare(baseB);
  });

  const lines = [`SDU Breakdown (Last ${hours}h):`];
  sortedEntries.forEach(([fleet, data]) => {
    const rent = getRentalCost(fleet);
    if (rent === "N/A" || isNaN(parseFloat(rent))) return;
    const valDynamic = (data.SDUs * price).toFixed(2);
    const val24h = (data.SDUs24h * price).toFixed(2);
    const roi = ((data.SDUs24h * price) / parseFloat(rent) * 100).toFixed(0) + "%";
    lines.push(`• ${fleet} (${data.baseName || ""})`);
    lines.push(`   ROI:  ${roi}`);
    lines.push(`   24h:  ${val24h} ATLAS`);
    lines.push(`   ${hours}h: ${valDynamic} ATLAS`);
    lines.push("");
  });
  return lines.join("\n");
}

// 6. Format net profit summary (detailed and mobile versions)
// [Net profit formatting functions remain unchanged]
function formatNetProfitSummary(
  net24h, netDynamic,
  netRented24h, netRentedDynamic,
  netOwned24h, netOwnedDynamic,
  hours, atlasUsd,
  totalVal24h, totalRent24h,
  rentedVal24h, rentedRent24h
) {
  const overallUsd24h = (net24h * atlasUsd).toFixed(2);
  const overallUsdDynamic = (netDynamic * atlasUsd).toFixed(2);
  const rentedUsd24h = (netRented24h * atlasUsd).toFixed(2);
  const rentedUsdDynamic = (netRentedDynamic * atlasUsd).toFixed(2);
  const ownedUsd24h = (netOwned24h * atlasUsd).toFixed(2);
  const ownedUsdDynamic = (netOwnedDynamic * atlasUsd).toFixed(2);

  const overallROI = totalRent24h > 0 ? ((totalVal24h / totalRent24h) * 100).toFixed(0) + "%" : "N/A";
  const rentedROI = rentedRent24h > 0 ? ((rentedVal24h / rentedRent24h) * 100).toFixed(0) + "%" : "N/A";

  const headers = ["Category", "24h(ATLAS)", "24h(USD)", `Last ${hours}h(ATLAS)`, `Last ${hours}h(USD)`, "ROI"];
  const rowsData = [
    {
      Category: "Rented",
      "24h(ATLAS)": netRented24h.toFixed(2),
      "24h(USD)": rentedUsd24h,
      [`Last ${hours}h(ATLAS)`]: netRentedDynamic.toFixed(2),
      [`Last ${hours}h(USD)`]: rentedUsdDynamic,
      ROI: rentedROI
    },
    {
      Category: "Owned",
      "24h(ATLAS)": netOwned24h.toFixed(2),
      "24h(USD)": ownedUsd24h,
      [`Last ${hours}h(ATLAS)`]: netOwnedDynamic.toFixed(2),
      [`Last ${hours}h(USD)`]: ownedUsdDynamic,
      ROI: "N/A"
    },
    {
      Category: "Overall",
      "24h(ATLAS)": net24h.toFixed(2),
      "24h(USD)": overallUsd24h,
      [`Last ${hours}h(ATLAS)`]: netDynamic.toFixed(2),
      [`Last ${hours}h(USD)`]: overallUsdDynamic,
      ROI: overallROI
    }
  ];

  const colWidths = headers.map(h => h.length);
  rowsData.forEach(row => {
    headers.forEach((header, i) => {
      const cell = String(row[header]);
      if (cell.length > colWidths[i]) colWidths[i] = cell.length;
    });
  });

  const headerRow = headers.map((h, i) => h.padEnd(colWidths[i])).join("   ");
  const separatorRow = colWidths.map(w => "-".repeat(w)).join("   ");
  const dataRows = rowsData.map(row =>
    headers.map((header, i) => String(row[header]).padEnd(colWidths[i])).join("   ")
  );

  return `Net Profits:\n${headerRow}\n${separatorRow}\n${dataRows.join("\n")}`;
}

function formatNetProfitSummaryMobile(
  net24h, netDynamic,
  netRented24h, netRentedDynamic,
  netOwned24h, netOwnedDynamic,
  hours, atlasUsd
) {
  const rentedUsd24h = (netRented24h * atlasUsd).toFixed(2);
  const rentedUsdDynamic = (netRentedDynamic * atlasUsd).toFixed(2);
  const ownedUsd24h = (netOwned24h * atlasUsd).toFixed(2);
  const ownedUsdDynamic = (netOwnedDynamic * atlasUsd).toFixed(2);
  const overallUsd24h = (net24h * atlasUsd).toFixed(2);
  const overallUsdDynamic = (netDynamic * atlasUsd).toFixed(2);

  let lines = ["Net Profits:"];
  lines.push(`• Rented`);
  lines.push(`    24h:     ${netRented24h.toFixed(2)} ATLAS (${rentedUsd24h} USD)`);
  lines.push(`    Last ${hours}h: ${netRentedDynamic.toFixed(2)} ATLAS (${rentedUsdDynamic} USD)`);
  lines.push("");
  lines.push(`• Owned`);
  lines.push(`    24h:     ${netOwned24h.toFixed(2)} ATLAS (${ownedUsd24h} USD)`);
  lines.push(`    Last ${hours}h: ${netOwnedDynamic.toFixed(2)} ATLAS (${ownedUsdDynamic} USD)`);
  lines.push("");
  lines.push(`• Overall`);
  lines.push(`    24h:     ${net24h.toFixed(2)} ATLAS (${overallUsd24h} USD)`);
  lines.push(`    Last ${hours}h: ${netDynamic.toFixed(2)} ATLAS (${overallUsdDynamic} USD)`);
  return lines.join("\n");
}

// 7. Combine fleet table and net profit summary; append current SDU price
function buildFinalMessage(
  fleetTableStr,
  net24h, netDynamic,
  netRented24h, netRentedDynamic,
  netOwned24h, netOwnedDynamic,
  hours, atlasUsd,
  totalVal24h, totalRent24h,
  rentedVal24h, rentedRent24h,
  isMobile,
  currentPrice
) {
  let summaryStr;
  if (isMobile) {
    summaryStr = formatNetProfitSummaryMobile(
      net24h, netDynamic,
      netRented24h, netRentedDynamic,
      netOwned24h, netOwnedDynamic,
      hours, atlasUsd
    );
  } else {
    summaryStr = formatNetProfitSummary(
      net24h, netDynamic,
      netRented24h, netRentedDynamic,
      netOwned24h, netOwnedDynamic,
      hours, atlasUsd,
      totalVal24h, totalRent24h,
      rentedVal24h, rentedRent24h
    );
  }
  const priceLine = `Current SDU Price: ${currentPrice.toFixed(2)} ATLAS (${(currentPrice * atlasUsd).toFixed(2)} USD)`;
  return fleetTableStr + "\n\n" + summaryStr + "\n\n" + priceLine;
}

// 8. Compute net profits and other metrics
async function analyzeAndFormatLocal(hours = 24, basesMapping) {
  const fleetData = await processCSV(hours, basesMapping);
  const lowestPriceObj = await getLowestSDUPrice();
  if (!lowestPriceObj || !lowestPriceObj.price) throw new Error("No valid SDU price found.");
  const currentPrice = parseFloat(lowestPriceObj.price);
  const atlasUsd = await getAtlasUsdPrice();

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

  return {
    fleetData,
    currentPrice,
    atlasUsd,
    net24h,
    netDynamic,
    netRented24h,
    netRentedDynamic,
    netOwned24h,
    netOwnedDynamic,
    totalVal24h,
    totalRent24h,
    rentedVal24h,
    rentedRent24h
  };
}

// 9. Main function
async function main() {
  const args = process.argv.slice(2);
  const usePushover = args[0] === "pushover";
  const hoursArgIndex = usePushover ? 1 : 0;
  const hours = args.length > hoursArgIndex ? parseInt(args[hoursArgIndex], 10) || 24 : 24;

  // Load bases mapping from .bases file
  const basesMapping = loadBasesMapping();

  try {
    const {
      fleetData,
      currentPrice,
      atlasUsd,
      net24h,
      netDynamic,
      netRented24h,
      netRentedDynamic,
      netOwned24h,
      netOwnedDynamic,
      totalVal24h,
      totalRent24h,
      rentedVal24h,
      rentedRent24h
    } = await analyzeAndFormatLocal(hours, basesMapping);

    const fleetTableStr = usePushover
      ? formatFleetTableMobile(fleetData, hours, currentPrice)
      : formatFleetTable(fleetData, hours, currentPrice);

    const finalMessage = buildFinalMessage(
      fleetTableStr,
      net24h,
      netDynamic,
      netRented24h,
      netRentedDynamic,
      netOwned24h,
      netOwnedDynamic,
      hours,
      atlasUsd,
      totalVal24h,
      totalRent24h,
      rentedVal24h,
      rentedRent24h,
      usePushover,
      currentPrice
    );

    if (usePushover) {
      const pushoverToken = process.env.PUSHOVER_TOKEN;
      const pushoverUser = process.env.PUSHOVER_USER;
      if (!pushoverToken || !pushoverUser) {
        console.error("Pushover credentials missing. Printing to stdout instead:");
        console.log(finalMessage);
      } else {
        await axios.post("https://api.pushover.net/1/messages.json", {
          token: pushoverToken,
          user: pushoverUser,
          message: finalMessage
        });
        console.log("Message sent to Pushover.");
      }
    } else {
      console.log(finalMessage);
    }
  } catch (err) {
    console.error("Error analyzing data:", err);
  }
}

main();
