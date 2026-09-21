#!/usr/bin/env bash
# WALL DETECTOR CODEBASE SEARCH -- run this in the liquidation-detector repo root.
# READ-ONLY. Just greps and prints -- no changes to any file.

echo "===================================================================="
echo "1. FILES MENTIONING THE SPECIFIC WALL FIELDS"
echo "===================================================================="
grep -rln "nearestBidWallPrice\|nearestBidWallUsd\|nearestBidWallPersistent\|nearestBidWallAgeMs\|nearestBidWallPeakNotional\|nearestAskWallPrice\|nearestAskWallUsd\|nearestAskWallPersistent\|nearestAskWallAgeMs\|nearestAskWallPeakNotional\|wallsPulled1m" src/ 2>/dev/null

echo ""
echo "===================================================================="
echo "2. GENERAL WALL/DEPTH/ORDERBOOK KEYWORD SEARCH"
echo "===================================================================="
grep -rln "wall\|bidWall\|askWall\|orderBook\|order_book" src/ --include="*.ts" 2>/dev/null

echo ""
echo "===================================================================="
echo "3. WHERE nearestBidWallPrice IS ASSIGNED/SET (not just read)"
echo "===================================================================="
grep -rn "nearestBidWallPrice\s*=\|nearestBidWallPrice:" src/ --include="*.ts" 2>/dev/null

echo ""
echo "===================================================================="
echo "4. WHERE wallsPulled1m IS ASSIGNED/SET"
echo "===================================================================="
grep -rn "wallsPulled1m\s*=\|wallsPulled1m:" src/ --include="*.ts" 2>/dev/null

echo ""
echo "===================================================================="
echo "5. BINANCE DEPTH STREAM SUBSCRIPTION (are individual price levels requested?)"
echo "===================================================================="
grep -rn "depth\|@depth\|partialBookDepth\|diffBookDepth" src/ --include="*.ts" | grep -i "ws\|stream\|subscribe\|url" 2>/dev/null

echo ""
echo "===================================================================="
echo "6. WHERE RAW bids/asks ARRAYS ARE PARSED FROM BINANCE"
echo "===================================================================="
grep -rn "\.bids\b\|\.asks\b\|bids:\|asks:" src/ --include="*.ts" 2>/dev/null | head -50

echo ""
echo "===================================================================="
echo "7. ORDER-BOOK CACHE / STORE CLASS NAMES"
echo "===================================================================="
grep -rln "class.*OrderBook\|class.*Depth\|class.*Wall" src/ --include="*.ts" 2>/dev/null

echo ""
echo "===================================================================="
echo "8. bestBid / bestAsk / bidDepthUsd / askDepthUsd / bookImbalance (the WORKING fields, for comparison)"
echo "===================================================================="
grep -rln "bestBid\|bestAsk\|bidDepthUsd\|askDepthUsd\|bookImbalance" src/ --include="*.ts" 2>/dev/null

echo ""
echo "===================================================================="
echo "9. THRESHOLD / CONFIG CONSTANTS NEAR 'WALL'"
echo "===================================================================="
grep -rn "WALL.*=\|wall.*[Mm]in\|wall.*[Tt]hreshold\|MIN.*WALL\|WALL.*USD\|WALL.*PERSIST" src/ --include="*.ts" 2>/dev/null

echo ""
echo "===================================================================="
echo "DONE -- paste this ENTIRE output back."
echo "===================================================================="