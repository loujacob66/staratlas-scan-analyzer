require('dotenv').config();
const fs = require('fs');
const csv = require('csv-parser');
const axios = require('axios');

// Load configuration from .env
const CSV_FILE = process.env.CSV_FILE_PATH || '/mnt/star_atlas/scanning/scan_stats.csv';
const PUSHOVER_USER = process.env.PUSHOVER_USER;
const PUSHOVER_TOKEN = process.env.PUSHOVER_TOKEN;

// Process command-line arguments:
//   e.g. node analyze_sdu.js 5 pushover
//   e.g. node analyze_sdu.js pushover
//   e.g. node analyze_sdu.js 5
const args = process.argv.slice(2);
let daysParam = null;
let usePushover = false;

args.forEach(arg => {
  if (arg.toLowerCase() === 'pushover') {
    usePushover = true;
  } else if (!isNaN(arg)) {
    daysParam = parseInt(arg, 10);
  }
});

/**
 * Converts a duration (in milliseconds) to a string "X days, Y hours".
 */
function formatDuration(ms) {
  if (ms <= 0) return '0 days, 0 hours';

  const hoursTotal = Math.floor(ms / (1000 * 60 * 60));
  const days = Math.floor(hoursTotal / 24);
  const hours = hoursTotal % 24;

  return `${days} day${days === 1 ? '' : 's'}, ${hours} hour${hours === 1 ? '' : 's'}`;
}

let allRecords = [];

// Read CSV file and collect records
fs.createReadStream(CSV_FILE)
  .pipe(csv())
  .on('data', (row) => {
    // Convert Timestamp to a Date object (assuming ISO 8601 format)
    row.timestampDate = new Date(row.Timestamp);
    // Convert SDU Count to a number
    row.sduCount = Number(row['SDU Count']);
    allRecords.push(row);
  })
  .on('end', () => {
    if (allRecords.length === 0) {
      console.error("No records found in the logfile.");
      return;
    }

    // Determine total logfile timespan using allRecords
    const earliest = new Date(Math.min(...allRecords.map(r => r.timestampDate.getTime())));
    const latest = new Date(Math.max(...allRecords.map(r => r.timestampDate.getTime())));
    const totalLogfileMs = latest - earliest;
    const totalLogfileDurationStr = formatDuration(totalLogfileMs);

    // Filter records if daysParam is specified
    let records = allRecords;
    let filteredDurationStr = '';
    if (daysParam) {
      // Filter to the last N days from the maximum date
      const cutoffDate = new Date(latest.getTime() - daysParam * 24 * 60 * 60 * 1000);
      records = records.filter(r => r.timestampDate >= cutoffDate);

      // Compute actual filtered timespan (from earliest in the filtered set to latest)
      if (records.length > 0) {
        const earliestFiltered = new Date(Math.min(...records.map(r => r.timestampDate.getTime())));
        const latestFiltered = new Date(Math.max(...records.map(r => r.timestampDate.getTime())));
        filteredDurationStr = formatDuration(latestFiltered - earliestFiltered);
      } else {
        // If no records remain, filtered duration is 0
        filteredDurationStr = '0 days, 0 hours';
      }
    }

    // Compute overall efficiency for the selected records
    const totalScans = records.length;
    const successfulScans = records.filter(r => r.sduCount > 0).length;
    const overallEfficiency = totalScans > 0 ? (successfulScans / totalScans) * 100 : 0;

    // Compute fleet-by-fleet efficiency
    const fleetStats = {};
    records.forEach(record => {
      const fleet = record['Fleet Name'];
      if (!fleetStats[fleet]) {
        fleetStats[fleet] = { total: 0, successful: 0 };
      }
      fleetStats[fleet].total++;
      if (record.sduCount > 0) {
        fleetStats[fleet].successful++;
      }
    });

    // --------------------------
    // 1) Build Console (ASCII) Output
    // --------------------------
    
    // Prepare lines for the top header with consistent padding
    const labelWidth = 35;
    const consoleLines = [];

    consoleLines.push('-------------------------------------------------------');
    consoleLines.push('      SCU Scan Fleet Efficiency Report');
    consoleLines.push('-------------------------------------------------------');
    consoleLines.push('Total Logfile Duration:'.padEnd(labelWidth) + totalLogfileDurationStr);

    if (daysParam) {
      consoleLines.push(
        `Filtered Duration (last ${daysParam} days):`.padEnd(labelWidth) + filteredDurationStr
      );
    }
    consoleLines.push('Overall Efficiency:'.padEnd(labelWidth) + overallEfficiency.toFixed(2) + '%');

    // Build a nicely aligned table for fleets
    const fleetNames = Object.keys(fleetStats);
    const maxFleetNameLength = fleetNames.reduce((max, f) => Math.max(max, f.length), 0);
    const fleetNameColWidth = Math.max(maxFleetNameLength, 28); // minimum width

    // Table header
    const headerLine = `+-${'-'.repeat(fleetNameColWidth)}-+-${'-'.repeat(16)}-+`;
    let tableLines = [];
    tableLines.push('--- Breakdown by Fleet ---');
    tableLines.push(headerLine);
    tableLines.push(
      `| ${'Fleet Name'.padEnd(fleetNameColWidth)} | ${'Efficiency (%)'.padEnd(16)} |`
    );
    tableLines.push(headerLine);

    // Table rows
    fleetNames.forEach(fleet => {
      const stats = fleetStats[fleet];
      const efficiency = stats.total > 0 ? (stats.successful / stats.total) * 100 : 0;
      tableLines.push(
        `| ${fleet.padEnd(fleetNameColWidth)} | ${efficiency.toFixed(2).padEnd(16)} |`
      );
    });

    // Table footer
    tableLines.push(headerLine);

    // Combine console lines
    const consoleMessage = consoleLines.join('\n') + '\n\n' + tableLines.join('\n');

    // Print to stdout
    console.log(consoleMessage);

    // --------------------------
    // 2) Build Pushover (Mobile-Friendly) Output
    // --------------------------
    const pushoverLines = [];
    pushoverLines.push('SCU Scan Fleet Efficiency Report');
    pushoverLines.push('');
    pushoverLines.push(`Total Logfile Duration: ${totalLogfileDurationStr}`);
    if (daysParam) {
      pushoverLines.push(`Filtered Duration (last ${daysParam} days): ${filteredDurationStr}`);
    }
    pushoverLines.push(`Overall Efficiency: ${overallEfficiency.toFixed(2)}%`);
    pushoverLines.push('');
    pushoverLines.push('Breakdown by Fleet:');

    fleetNames.forEach(fleet => {
      const stats = fleetStats[fleet];
      const efficiency = stats.total > 0 ? (stats.successful / stats.total) * 100 : 0;
      pushoverLines.push(` • ${fleet}: ${efficiency.toFixed(2)}%`);
    });

    const pushoverMessage = pushoverLines.join('\n');

    // Optionally send Pushover notification if "pushover" argument is present
    if (usePushover) {
      if (!PUSHOVER_USER || !PUSHOVER_TOKEN) {
        console.error("Pushover requested but PUSHOVER_USER or PUSHOVER_TOKEN not set.");
        return;
      }
      axios.post('https://api.pushover.net/1/messages.json', null, {
        params: {
          token: PUSHOVER_TOKEN,
          user: PUSHOVER_USER,
          message: pushoverMessage,
          title: 'SCU Scan Fleet Efficiency'
        }
      })
      .then(() => {
        console.log('Pushover notification sent.');
      })
      .catch(error => {
        console.error('Error sending Pushover notification:', error.message);
      });
    }
  })
  .on('error', (error) => {
    console.error(`Error reading CSV file: ${error.message}`);
  });
