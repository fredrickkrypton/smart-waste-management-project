import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore, collection, onSnapshot, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// ============================================
// FIREBASE CONFIGURATION
// ============================================

const firebaseConfig = {
    apiKey: "AIzaSyBq5hzOfU0phdLThW-04vYZ7Cx7Sfp8COA",
    authDomain: "smart-waste-management-project.firebaseapp.com",
    projectId: "smart-waste-management-project",
    storageBucket: "smart-waste-management-project.firebasestorage.app",
    messagingSenderId: "309823595593",
    appId: "1:309823595593:web:e034dfea3c30f1b9470b98",
    measurementId: "G-299WLEH7XQ"
};

let app, db;
try {
    app = initializeApp(firebaseConfig);
    db = getFirestore(app);
    const statusEl = document.getElementById('firestore-status');
    const statusDetailEl = document.getElementById('firestore-status-detail');
    if (statusEl) {
        statusEl.innerText = 'CONNECTED';
        statusEl.style.color = '#10b981';
    }
    if (statusDetailEl) {
        statusDetailEl.innerText = 'Connected';
        statusDetailEl.style.color = '#10b981';
    }
    console.log('✅ Firebase initialized with project:', firebaseConfig.projectId);
} catch (error) {
    console.error('❌ Firebase init error:', error);
    const statusEl = document.getElementById('firestore-status');
    const statusDetailEl = document.getElementById('firestore-status-detail');
    if (statusEl) {
        statusEl.innerText = 'FAILED';
        statusEl.style.color = '#ef4444';
    }
    if (statusDetailEl) {
        statusDetailEl.innerText = 'Failed';
        statusDetailEl.style.color = '#ef4444';
    }
}

// ============================================
// UTILITY FUNCTIONS
// ============================================

function waitForLeaflet() {
    return new Promise((resolve) => {
        if (typeof L !== 'undefined') {
            resolve();
            return;
        }

        const checkInterval = setInterval(() => {
            if (typeof L !== 'undefined') {
                clearInterval(checkInterval);
                resolve();
            }
        }, 200);

        setTimeout(() => {
            clearInterval(checkInterval);
            console.warn('Leaflet timeout - map will be disabled');
            resolve();
        }, 8000);
    });
}

function getBinStatus(bin) {
    const level = Number(bin?.level || 0);
    return bin?.status || (level > 80 ? 'CRITICAL' : level > 60 ? 'WARNING' : 'OK');
}

function getBinTimestamp(bin) {
    return bin?.last_updated?.toDate?.() || bin?.last_classification?.toDate?.() || null;
}

function getBinLevelColor(level) {
    if (level > 80) return 'danger';
    if (level > 60) return 'warning';
    return 'success';
}

function roundPercent(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    return Math.max(0, Math.round(numeric));
}

function formatPercent(value) {
    return `${roundPercent(value)}%`;
}

// Weight model defaults (kg per m^3). Tune these values using real pickup measurements.
const WASTE_DENSITY_DEFAULTS = {
    recyclable: 120,
    organic: 450,
    hazardous: 300
};

// Fleet base station (truck depot) - trucks start/return here
const BASE_STATION = [0.32376, 32.57270];

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function getBinVolumeM3(bin) {
    const volumeM3 = Number(bin?.bin_volume_m3 ?? bin?.capacity_m3);
    if (Number.isFinite(volumeM3) && volumeM3 > 0) return volumeM3;

    const volumeLiters = Number(bin?.capacity_liters ?? bin?.capacity_litres);
    if (Number.isFinite(volumeLiters) && volumeLiters > 0) return volumeLiters / 1000;

    return null;
}

function normalizeWasteComposition(composition) {
    if (!composition || typeof composition !== 'object') return null;

    const recyclable = Number(composition.recyclable || 0);
    const organic = Number(composition.organic || 0);
    const hazardous = Number(composition.hazardous || 0);
    const total = recyclable + organic + hazardous;

    if (!(total > 0)) return null;

    // Works for both percentage inputs (sum around 100) and fraction inputs (sum around 1).
    return {
        recyclable: recyclable / total,
        organic: organic / total,
        hazardous: hazardous / total
    };
}

function estimateBinWeightKg(bin) {
    const level = clamp(Number(bin?.level || 0), 0, 100);

    // Fallback to legacy heuristic for backwards compatibility.
    const legacyEstimate = level * 0.5;

    const volumeM3 = getBinVolumeM3(bin);
    const composition = normalizeWasteComposition(bin?.waste_composition);
    if (!volumeM3 || !composition) return legacyEstimate;

    const weightedDensity =
        (composition.recyclable * WASTE_DENSITY_DEFAULTS.recyclable) +
        (composition.organic * WASTE_DENSITY_DEFAULTS.organic) +
        (composition.hazardous * WASTE_DENSITY_DEFAULTS.hazardous);

    const estimatedKg = (level / 100) * volumeM3 * weightedDensity;
    return Number.isFinite(estimatedKg) ? estimatedKg : legacyEstimate;
}

function getRouteBearing(start, end) {
    const startLat = start[0] * Math.PI / 180;
    const startLng = start[1] * Math.PI / 180;
    const endLat = end[0] * Math.PI / 180;
    const endLng = end[1] * Math.PI / 180;
    const y = Math.sin(endLng - startLng) * Math.cos(endLat);
    const x = Math.cos(startLat) * Math.sin(endLat) - Math.sin(startLat) * Math.cos(endLat) * Math.cos(endLng - startLng);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function clearRouteArrows(map, routeArrows) {
    if (!map || !routeArrows.length) return;
    routeArrows.forEach((marker) => map.removeLayer(marker));
    routeArrows.length = 0;
}

function addRouteArrows(map, routePoints, routeArrows) {
    if (!map || !Array.isArray(routePoints) || routePoints.length < 2 || typeof L === 'undefined') return;

    clearRouteArrows(map, routeArrows);

    const step = Math.max(6, Math.floor(routePoints.length / 12));

    for (let index = step; index < routePoints.length - 1; index += step) {
        const point = routePoints[index];
        const nextPoint = routePoints[Math.min(routePoints.length - 1, index + 1)];
        if (!point || !nextPoint) continue;

        const bearing = getRouteBearing(point, nextPoint);
        const arrowMarker = L.marker(point, {
            interactive: false,
            keyboard: false,
            zIndexOffset: 2000,
            icon: L.divIcon({
                className: 'route-direction-marker',
                html: `
                    <div class="route-direction-arrow" style="transform: rotate(${bearing}deg);">
                        <i class="fas fa-arrow-up"></i>
                    </div>
                `,
                iconSize: [24, 24],
                iconAnchor: [12, 12]
            })
        }).addTo(map);

        routeArrows.push(arrowMarker);
    }
}

function drawRouteWithArrows(map, routePoints, routeArrows, options = {}) {
    if (!map || !Array.isArray(routePoints) || routePoints.length < 2) return null;

    const route = L.polyline(routePoints, {
        color: '#059669',
        weight: 5,
        opacity: options.fallback ? 0.85 : 0.95,
        dashArray: options.fallback ? '8, 8' : null,
        lineJoin: 'round',
        lineCap: 'round'
    }).addTo(map);

    addRouteArrows(map, routePoints, routeArrows);
    map.fitBounds(route.getBounds(), { padding: [30, 30] });
    return route;
}

async function fetchCachedHistoryMap() {
    try {
        const response = await fetch('/api/bins?skip_sim=1', { credentials: 'include' });
        if (!response.ok) return new Map();
        const bins = await response.json();
        const map = new Map();
        bins.forEach((bin) => {
            if (!bin) return;
            if (bin.id) map.set(bin.id, bin);
            if (bin.bin_id) map.set(bin.bin_id, bin);
        });
        return map;
    } catch (error) {
        console.warn('Cached history fetch failed:', error);
        return new Map();
    }
}

async function getRoadAlignedRoute(waypoints) {
    const depot = BASE_STATION;
    const routePoints = [depot, ...waypoints];
    const coordinates = routePoints.map(([lat, lng]) => `${lng},${lat}`).join(';');
    const url = `https://router.project-osrm.org/trip/v1/driving/${coordinates}?overview=full&geometries=geojson&roundtrip=false&source=first&destination=last`;

    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Routing service returned ${response.status}`);
    }

    const data = await response.json();
    if (data.code !== 'Ok' || !data.trips || !data.trips.length) {
        throw new Error(data.message || 'Unable to build road route');
    }

    const routeGeometry = data.trips[0].geometry.coordinates.map(([lng, lat]) => [lat, lng]);
    const distanceInMeters = data.trips[0].distance || 0;
    const distanceInKm = (distanceInMeters / 1000).toFixed(2);

    return {
        geometry: routeGeometry,
        distance: distanceInKm,
        distanceMeters: distanceInMeters
    };
}

// ============================================
// FUEL CONSUMPTION CALCULATION
// ============================================
// Uganda waste trucks average fuel consumption: 4-6 liters per 100km
// Using 5 liters per 100km as baseline for heavy-duty garbage trucks
function calculateFuelConsumption(distanceKm) {
    // Use a more realistic heavy truck baseline (liters per 100km).
    // Heavy garbage trucks commonly consume ~25-35 L/100km depending on load and stops.
    const fuelEfficiency = 30; // liters per 100km (baseline for heavy-duty trucks)
    const urbanFactor = 1.2; // account for stop-start, idling, urban traffic
    const fuelNeeded = (distanceKm / 100) * fuelEfficiency * urbanFactor;
    return fuelNeeded.toFixed(2);
}

// ============================================
// DASHBOARD INITIALIZATION
// ============================================

document.addEventListener('DOMContentLoaded', async () => {
    console.log('📄 DOM loaded, initializing Eco-Tech Uganda dashboard...');

    const userRole = document.body.dataset.userRole || 'viewer';
    const roleSpan = document.getElementById('user-role');
    if (roleSpan) roleSpan.innerText = userRole.toUpperCase();

    // Role-based UI adjustments
    if (userRole !== 'admin') {
        const adminControls = document.getElementById('admin-controls');
        const analyticsSection = document.getElementById('analytics-section');
        if (adminControls) adminControls.style.display = 'none';
        if (analyticsSection) analyticsSection.style.display = 'none';
    }

    if (userRole === 'viewer') {
        const btnOptimize = document.getElementById('btnOptimize');
        const btnClear = document.getElementById('btnClear');
        if (btnOptimize) btnOptimize.style.display = 'none';
        if (btnClear) btnClear.style.display = 'none';
    }

    await waitForLeaflet();

    // ============================================
    // STATE MANAGEMENT
    // ============================================

    let map = null;
    let markers = [];
    let currentRoute = null;
    let currentRouteArrows = [];
    let currentLiveBins = [];
    const binHistory = new Map();
    let activeRangeKey = '24h';

    const RANGE_CONFIG = {
        '1h': { label: 'last 1 hour', windowMs: 60 * 60 * 1000, buckets: 60, bucketMs: 1 * 60 * 1000, short: '1H' },
        '24h': { label: 'last 24 hours', windowMs: 24 * 60 * 60 * 1000, buckets: 8, bucketMs: 3 * 60 * 60 * 1000, short: '24H' },
        '7d': { label: 'last 7 days', windowMs: 7 * 24 * 60 * 60 * 1000, buckets: 7, bucketMs: 24 * 60 * 60 * 1000, short: '7D' }
    };

    // ============================================
    // ANALYTICS FUNCTIONS
    // ============================================

    function getBinsForRange(bins, rangeKey) {
        const config = RANGE_CONFIG[rangeKey] || RANGE_CONFIG['24h'];
        const cutoff = Date.now() - config.windowMs;
        return bins.filter((bin) => {
            const timestamp = getBinTimestamp(bin);
            return timestamp && timestamp.getTime() >= cutoff;
        });
    }

    function buildHistorySamples(bins) {
        const samples = [];
        bins.forEach((bin) => {
            if (!Array.isArray(bin?.cycle_history)) return;
            bin.cycle_history.forEach((entry) => {
                if (!entry) return;
                samples.push({
                    ...bin,
                    level: entry.level ?? bin.level,
                    waste_composition: entry.waste_composition || bin.waste_composition,
                    last_updated: entry.time || bin.last_updated
                });
            });
        });
        return samples;
    }

    function formatBucketLabel(rangeKey, offsetFromNow) {
        if (rangeKey === '1h') return `${offsetFromNow}m`;
        if (rangeKey === '24h') return `${offsetFromNow * 3}h`;
        if (rangeKey === '7d') return `${offsetFromNow}d`;
        return `${offsetFromNow}`;
    }

    function renderRangeToggle() {
        ['1h', '24h', '7d'].forEach((range) => {
            const button = document.getElementById(`range-${range}`);
            if (!button) return;
            const isActive = activeRangeKey === range;
            button.className = `range-btn${isActive ? ' active' : ''}`;
        });

        const label = document.getElementById('analytics-range-label');
        const config = RANGE_CONFIG[activeRangeKey] || RANGE_CONFIG['24h'];
        if (label) label.innerText = `Showing ${config.label}`;
    }

    function renderCompositionChart(binsInRange) {
        const donut = document.getElementById('composition-donut');
        const center = document.getElementById('composition-center');
        const scope = document.getElementById('composition-scope');
        const rEl = document.getElementById('legend-recyclable');
        const oEl = document.getElementById('legend-organic');
        const hEl = document.getElementById('legend-hazardous');
        const note = document.getElementById('composition-note');

        if (scope) scope.innerText = `${binsInRange.length} bins analyzed`;
        if (note) note.innerText = 'This chart shows which type of rubbish is most common in the bins being checked.';

        if (!binsInRange.length) {
            if (donut) donut.style.background = 'conic-gradient(#e5e7eb 0 100%)';
            if (center) center.innerText = 'No Data';
            if (rEl) rEl.innerText = '0%';
            if (oEl) oEl.innerText = '0%';
            if (hEl) hEl.innerText = '0%';
            return;
        }

        let recyclable = 0, organic = 0, hazardous = 0, compositionCount = 0;

        binsInRange.forEach((bin) => {
            const composition = bin?.waste_composition || {};
            const r = Number(composition.recyclable || 0);
            const o = Number(composition.organic || 0);
            const h = Number(composition.hazardous || 0);
            if (r || o || h) {
                recyclable += r;
                organic += o;
                hazardous += h;
                compositionCount += 1;
            }
        });

        if (!compositionCount) {
            if (donut) donut.style.background = 'conic-gradient(#e5e7eb 0 100%)';
            if (center) center.innerText = 'No\nData';
            if (rEl) rEl.innerText = '0%';
            if (oEl) oEl.innerText = '0%';
            if (hEl) hEl.innerText = '0%';
            return;
        }

        recyclable = recyclable / compositionCount;
        organic = organic / compositionCount;
        hazardous = hazardous / compositionCount;

        const total = recyclable + organic + hazardous || 1;
        const rPct = (recyclable / total) * 100;
        const oPct = (organic / total) * 100;
        const hPct = Math.max(0, 100 - rPct - oPct);

        if (donut) {
            donut.style.background = `conic-gradient(#10b981 0 ${rPct}%, #f59e0b ${rPct}% ${rPct + oPct}%, #ef4444 ${rPct + oPct}% 100%)`;
        }
        if (center) center.innerText = `Avg\n${formatPercent(total)}`;
        if (rEl) rEl.innerText = formatPercent(rPct);
        if (oEl) oEl.innerText = formatPercent(oPct);
        if (hEl) hEl.innerText = formatPercent(hPct);
        if (note) note.innerText = `Most of the waste here is ${[
            ['recyclable', rPct],
            ['organic', oPct],
            ['hazardous', hPct]
        ].sort((a, b) => b[1] - a[1])[0][0]} waste, based on the selected time range.`;
    }

    function renderTrendChart(bins) {
        const container = document.getElementById('volume-bars');
        const summary = document.getElementById('trend-summary');
        const note = document.getElementById('trend-note');

        if (!container) return;

        const latestBin = getLatestBin(bins);
        const fallbackBin = bins.find((bin) => Array.isArray(bin?.cycle_history) && bin.cycle_history.length);
        const sourceBin = (Array.isArray(latestBin?.cycle_history) && latestBin.cycle_history.length)
            ? latestBin
            : fallbackBin;
        const history = Array.isArray(sourceBin?.cycle_history) ? sourceBin.cycle_history : [];
        const entries = history.slice(-10);
        container.style.gridTemplateColumns = 'repeat(10, 1fr)';

        if (!sourceBin || entries.length === 0) {
            if (summary) summary.innerText = 'No cycle data';
            if (note) note.innerText = 'Waiting for cycle history from the selected bin.';
            container.innerHTML = '<div class="analytics-empty">No cycle history available yet.</div>';
            return;
        }

        const toTime = (value) => {
            if (value?.toDate) return value.toDate().getTime();
            const parsed = new Date(value);
            return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
        };

        const sorted = entries
            .map((entry, index) => ({
                ...entry,
                index,
                timeMs: toTime(entry.time)
            }))
            .sort((a, b) => (a.timeMs || 0) - (b.timeMs || 0));

        const levels = sorted.map((entry) => Number(entry.level || 0));
        const peak = Math.max(100, ...levels);
        const avg = levels.length ? levels.reduce((acc, value) => acc + value, 0) / levels.length : 0;

        if (summary) summary.innerText = `Avg ${formatPercent(avg)}`;
        if (note) note.innerText = `Latest ${levels.length} cycles from ${sourceBin.display_label || sourceBin.bin_id || sourceBin.id}.`;

        container.innerHTML = sorted.map((entry, index) => {
            const height = Math.max(8, Math.round((Number(entry.level || 0) / peak) * 180));
            const label = entry.cycle_number ?? `#${index + 1}`;
            return `
                <div class="bar-column">
                    <div class="bar-value-label">${formatPercent(entry.level || 0)}</div>
                    <div class="bar-visual" style="height:${height}px"></div>
                    <div class="bar-time-label">${label}</div>
                </div>
            `;
        }).join('');
    }

    function getAreaName(bin) {
        const raw = (bin?.neighborhood || bin?.zone || bin?.location_name || bin?.label || bin?.id || 'Unknown Area').toString().trim();
        if (!raw) return 'Unknown Area';
        if (!bin?.location_name && raw.includes('-')) return raw.split('-')[0];
        return raw.length > 22 ? `${raw.slice(0, 22)}...` : raw;
    }

    function updateBinHistory(bins) {
        const now = Date.now();
        bins.forEach((bin) => {
            if (!bin?.id) return;
            const level = Number(bin.level || 0);
            const timestamp = getBinTimestamp(bin)?.getTime() || now;
            const history = binHistory.get(bin.id) || [];
            const lastPoint = history[history.length - 1];

            if (!lastPoint || lastPoint.level !== level || timestamp - lastPoint.time > 5 * 60 * 1000) {
                history.push({ time: timestamp, level });
            }

            const recent = history.filter((point) => now - point.time <= 12 * 60 * 60 * 1000).slice(-30);
            binHistory.set(bin.id, recent);
        });
    }

    function renderWasteTrendByLocation(binsInRange) {
        const container = document.getElementById('location-waste-trend');
        const summary = document.getElementById('location-waste-summary');
        const note = document.getElementById('location-waste-note');
        if (!container) return;

        const areaStats = {};

        binsInRange.forEach((bin) => {
            const composition = bin?.waste_composition || {};
            const recyclable = Number(composition.recyclable || 0);
            const organic = Number(composition.organic || 0);
            const hazardous = Number(composition.hazardous || 0);
            if (!(recyclable || organic || hazardous)) return;

            const area = getAreaName(bin);
            if (!areaStats[area]) {
                areaStats[area] = { recyclable: 0, organic: 0, hazardous: 0, count: 0 };
            }

            areaStats[area].recyclable += recyclable;
            areaStats[area].organic += organic;
            areaStats[area].hazardous += hazardous;
            areaStats[area].count += 1;
        });

        const rankedAreas = Object.entries(areaStats)
            .map(([area, values]) => {
                const total = values.recyclable + values.organic + values.hazardous || 1;
                const rPct = (values.recyclable / total) * 100;
                const oPct = (values.organic / total) * 100;
                const hPct = Math.max(0, 100 - rPct - oPct);
                const dominant = [
                    ['Recyclable', rPct],
                    ['Organic', oPct],
                    ['Hazardous', hPct]
                ].sort((a, b) => b[1] - a[1])[0];

                return { area, rPct, oPct, hPct, dominant: dominant[0], dominantPct: dominant[1], sampleCount: values.count };
            })
            .sort((a, b) => b.sampleCount - a.sampleCount)
            .slice(0, 5);

        if (!rankedAreas.length) {
            if (summary) summary.innerText = 'No data';
            if (note) note.innerText = 'No category trends yet. As bins get classified, this will show what each area throws away most.';
            container.innerHTML = '<div class="analytics-empty">No location waste trend available yet.</div>';
            return;
        }

        const topArea = rankedAreas[0];
        if (summary) summary.innerText = `${topArea.area}: mostly ${topArea.dominant}`;
        if (note) note.innerText = `In simple terms: ${topArea.area} currently has the strongest ${topArea.dominant.toLowerCase()} waste pattern, which helps plan sorting and awareness in that neighborhood.`;

        container.innerHTML = rankedAreas.map((item) => `
            <div class="location-trend-row">
                <div class="location-trend-row-header">
                    <span class="location-name">${item.area}</span>
                    <span class="location-dominant">Mostly ${item.dominant} (${formatPercent(item.dominantPct)})</span>
                </div>
                <div class="location-composition-bar">
                    <span class="location-segment recyclable" style="width:${item.rPct.toFixed(1)}%"></span>
                    <span class="location-segment organic" style="width:${item.oPct.toFixed(1)}%"></span>
                    <span class="location-segment hazardous" style="width:${item.hPct.toFixed(1)}%"></span>
                </div>
            </div>
        `).join('');
    }


    function renderPresentationCharts(bins) {
        const historySamples = buildHistorySamples(bins);
        const source = historySamples.length ? historySamples : bins;
        const inRange = getBinsForRange(source, activeRangeKey);
        updateBinHistory(bins);
        renderRangeToggle();
        renderCompositionChart(inRange);
        renderTrendChart(bins);
        renderWasteTrendByLocation(inRange);
    }

    // ============================================
    // UI UPDATE FUNCTIONS
    // ============================================

    function getLatestBin(bins) {
        if (!bins || bins.length === 0) return null;
        return bins.reduce((latest, current) => {
            const latestTime = latest?.last_updated?.toDate?.() || latest?.last_classification?.toDate?.() || new Date(0);
            const currentTime = current?.last_updated?.toDate?.() || current?.last_classification?.toDate?.() || new Date(0);
            return currentTime > latestTime ? current : latest;
        }, bins[0]);
    }

    function renderOperationalSnapshot(bins) {
        const total = bins.length;
        const critical = bins.filter(bin => Number(bin?.level || 0) > 80).length;
        const warning = bins.filter(bin => Number(bin?.level || 0) > 60 && Number(bin?.level || 0) <= 80).length;
        const healthy = Math.max(0, total - critical - warning);

        const liveBinsEl = document.getElementById('live-bin-count');
        const inventoryCountEl = document.getElementById('inventory-count');
        if (liveBinsEl) liveBinsEl.innerText = String(total);
        if (inventoryCountEl) inventoryCountEl.innerText = `${total} Bins`;

        const percent = total > 0 ? (value) => Math.round((value / total) * 100) : () => 0;

        const criticalCountEl = document.getElementById('critical-count');
        const warningCountEl = document.getElementById('warning-count');
        const healthyCountEl = document.getElementById('healthy-count');
        const criticalBarEl = document.getElementById('critical-bar');
        const warningBarEl = document.getElementById('warning-bar');
        const healthyBarEl = document.getElementById('healthy-bar');
        const criticalProgressEl = document.getElementById('critical-progress');

        if (criticalCountEl) criticalCountEl.innerText = critical;
        if (warningCountEl) warningCountEl.innerText = warning;
        if (healthyCountEl) healthyCountEl.innerText = healthy;
        if (criticalBarEl) criticalBarEl.style.width = `${percent(critical)}%`;
        if (warningBarEl) warningBarEl.style.width = `${percent(warning)}%`;
        if (healthyBarEl) healthyBarEl.style.width = `${percent(healthy)}%`;
        if (criticalProgressEl) criticalProgressEl.style.width = `${percent(critical)}%`;

        const latestBin = getLatestBin(bins);
        const selectedIdEl = document.getElementById('selected-bin-id');
        const selectedLevelEl = document.getElementById('selected-bin-level');
        const selectedStatusEl = document.getElementById('selected-bin-status');
        const selectedTimeEl = document.getElementById('selected-bin-time');
        const selectedCoordsEl = document.getElementById('selected-bin-coords');
        const selectedAlertEl = document.getElementById('selected-bin-alert');
        const selectedCycleEl = document.getElementById('selected-bin-cycle');
        const selectedTrendEl = document.getElementById('selected-bin-trend');
        const selectedHistoricalEl = document.getElementById('selected-bin-historical');
        const routeStatusText = document.getElementById('route-status-text');

        if (latestBin) {
            const level = Number(latestBin.level || 0);
            if (selectedIdEl) selectedIdEl.innerText = latestBin.id || '--';
            if (selectedLevelEl) selectedLevelEl.innerText = formatPercent(level);
            if (selectedStatusEl) selectedStatusEl.innerText = getBinStatus(latestBin);
            if (selectedCoordsEl) selectedCoordsEl.innerText = `${latestBin.lat?.toFixed(4) ?? '--'}, ${latestBin.lng?.toFixed(4) ?? '--'}`;
            if (selectedAlertEl) selectedAlertEl.innerText = latestBin.alert_triggered ? '⚠️ YES' : '✅ NO';
            if (selectedCycleEl) selectedCycleEl.innerText = latestBin.cycle_number ?? '--';
            if (selectedTrendEl) {
                const trendValue = (latestBin.trend || '').toString().toLowerCase();
                selectedTrendEl.innerText = latestBin.trend || '--';
                selectedTrendEl.classList.remove('trend-up', 'trend-down', 'trend-flat', 'trend-unknown');

                if (trendValue.includes('increase') || trendValue.includes('up') || trendValue.includes('rising')) {
                    selectedTrendEl.classList.add('trend-up');
                } else if (trendValue.includes('decrease') || trendValue.includes('down') || trendValue.includes('fall')) {
                    selectedTrendEl.classList.add('trend-down');
                } else if (trendValue.includes('stable') || trendValue.includes('flat') || trendValue.includes('steady')) {
                    selectedTrendEl.classList.add('trend-flat');
                } else if (trendValue) {
                    selectedTrendEl.classList.add('trend-unknown');
                }
            }
            if (selectedHistoricalEl) {
                selectedHistoricalEl.innerText = latestBin.historical_avg == null
                    ? '--'
                    : formatPercent(latestBin.historical_avg);
            }

            const updateTime = latestBin.last_updated?.toDate?.() || latestBin.last_classification?.toDate?.() || new Date();
            if (selectedTimeEl) selectedTimeEl.innerText = updateTime.toLocaleTimeString();
            if (routeStatusText) routeStatusText.innerText = critical > 0 ? 'Immediate pickup required' : warning > 0 ? 'Monitor closely' : 'Stable';
        } else {
            if (selectedIdEl) selectedIdEl.innerText = '--';
            if (selectedLevelEl) selectedLevelEl.innerText = '--%';
            if (selectedStatusEl) selectedStatusEl.innerText = '--';
            if (selectedCoordsEl) selectedCoordsEl.innerText = '--';
            if (selectedAlertEl) selectedAlertEl.innerText = '--';
            if (selectedCycleEl) selectedCycleEl.innerText = '--';
            if (selectedTrendEl) {
                selectedTrendEl.innerText = '--';
                selectedTrendEl.classList.remove('trend-up', 'trend-down', 'trend-flat', 'trend-unknown');
            }
            if (selectedHistoricalEl) selectedHistoricalEl.innerText = '--';
            if (selectedTimeEl) selectedTimeEl.innerText = '--';
            if (routeStatusText) routeStatusText.innerText = 'Awaiting data';
        }
    }

    // ============================================
    // RANGE TOGGLE EVENT LISTENERS
    // ============================================

    ['1h', '24h', '7d'].forEach((rangeKey) => {
        const button = document.getElementById(`range-${rangeKey}`);
        if (!button) return;
        button.addEventListener('click', () => {
            activeRangeKey = rangeKey;
            renderPresentationCharts(currentLiveBins);
        });
    });

    renderPresentationCharts([]);

    // ============================================
    // MAP INITIALIZATION
    // ============================================

    if (typeof L !== 'undefined') {
        try {
            map = L.map('map').setView([0.3476, 32.5825], 13);
            L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
                attribution: '© OpenStreetMap contributors, © CARTO',
                subdomains: 'abcd',
                maxZoom: 20,
                detectRetina: true
            }).addTo(map);
            // Add base station marker (depot)
            try {
                const baseIcon = L.divIcon({
                    className: 'base-station-marker',
                    html: `<div class="base-station-marker__icon"><i class="fas fa-industry"></i></div>`,
                    iconSize: [36, 36],
                    iconAnchor: [18, 36]
                });
                const baseMarker = L.marker(BASE_STATION, { icon: baseIcon }).addTo(map);
                baseMarker.bindTooltip('Base Station', { permanent: true, direction: 'right', className: 'base-station-label', offset: [10, 0] });
            } catch (err) {
                console.warn('Base station marker failed:', err);
            }
            console.log('✅ Map initialized');
        } catch (error) {
            console.error('Map error:', error);
            const mapError = document.getElementById('map-error');
            if (mapError) mapError.style.display = 'flex';
        }
    } else {
        console.warn('Leaflet not available');
        const mapError = document.getElementById('map-error');
        if (mapError) mapError.style.display = 'flex';
    }

    // ============================================
    // MAIN UI UPDATE FUNCTION
    // ============================================

    function updateUI(data, mapObject, markersArray) {
        if (markersArray && markersArray.length) {
            markersArray.forEach((marker) => {
                if (mapObject && marker) mapObject.removeLayer(marker);
            });
            markersArray.length = 0;
        }

        let totalW = 0;
        let critC = 0;
        const list = document.getElementById('bin-status-list');
        const log = document.getElementById('activity-log');

        if (list) list.innerHTML = '';
        if (log) log.innerHTML = '';

        if (!data || data.length === 0) {
            if (list) list.innerHTML = '<div class="empty-inventory"><i class="fas fa-cube"></i><p>No bins found. Waiting for Pi sensor data...</p></div>';
            if (log) log.innerHTML = '<tr><td colspan="4" class="empty-table-message"><i class="fas fa-sync-alt fa-spin"></i> Waiting for sensor data...</td></tr>';
            document.getElementById('total-bins').innerText = '0';
            document.getElementById('full-bins').innerText = '0';
            return;
        }

        let binIndex = 1;
        data.forEach((bin) => {
            totalW += estimateBinWeightKg(bin);
            const level = Number(bin.level || 0);
            const color = getBinLevelColor(level);
            if (level > 80) critC++;

            const displayName = bin.bin_id || bin.id;
            const isAutoId = typeof bin?.id === 'string' && bin.id.length >= 18;
            const rawLabel = bin.display_label || displayName || bin.bin_code || bin.label || bin.location_name || bin.name || '';
            const label = (!rawLabel || (rawLabel === bin.id && isAutoId))
                ? `BIN_${String(binIndex).padStart(2, '0')}`
                : rawLabel;

            // Add map markers
            if (mapObject && bin.lat && bin.lng && typeof L !== 'undefined') {
                try {
                    const markerColor = level > 80 ? '#ef4444' : level > 60 ? '#f59e0b' : '#10b981';

                    const markerIcon = L.divIcon({
                        className: 'map-pin-marker',
                        html: `
                            <div class="map-pin-marker__icon" style="color: ${markerColor};">
                                <i class="fas fa-location-dot"></i>
                            </div>
                        `,
                        iconSize: [32, 42],
                        iconAnchor: [16, 42]
                    });

                    const marker = L.marker([bin.lat, bin.lng], { icon: markerIcon })
                        .addTo(mapObject)
                        .bindTooltip(label, {
                            permanent: true,
                            direction: 'top',
                            className: 'bin-pin-label',
                            offset: [0, -34],
                            opacity: 1
                        })
                        .bindPopup(`
                            <div style="font-family: 'Inter', sans-serif;">
                                <h4 style="margin: 0 0 8px; color: #059669;">${label}</h4>
                                <p style="margin: 4px 0;"><strong>Bin Code:</strong> ${label}</p>
                                <p style="margin: 4px 0; font-size: 0.85rem; color: #6b7280;"><strong>Firestore ID:</strong> ${bin.id}</p>
                                <p style="margin: 4px 0;"><strong>Cycle:</strong> ${bin.cycle_number ?? '--'}</p>
                                <p style="margin: 4px 0;"><strong>Fill Level:</strong> ${formatPercent(level)}</p>
                                <p style="margin: 4px 0;"><strong>Status:</strong> ${getBinStatus(bin)}</p>
                            </div>
                        `);
                    markersArray.push(marker);
                    binIndex++;
                } catch (error) {
                    console.warn('Marker error:', error);
                }
            }

            const timeNow = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

            if (bin.historical_avg) {
                console.log(`Historical avg: ${bin.historical_avg}%`);
            }
            if (bin.trend) {
                console.log(`Trend: ${bin.trend}`);
            }

            // Update bin inventory list
            if (list) {
                list.innerHTML += `
                    <div class="bin-card-premium">
                        <div class="bin-card-header">
                            <span class="bin-id"><i class="fas fa-qrcode"></i> ${label}</span>
                            <span class="bin-level-badge bg-${color}" style="background: ${level > 80 ? '#ef4444' : level > 60 ? '#f59e0b' : '#10b981'}; color: white;">${formatPercent(level)}</span>
                        </div>
                        <div class="bin-progress">
                            <div class="bin-progress-bar" style="width: ${level}%; background: ${level > 80 ? '#ef4444' : level > 60 ? '#f59e0b' : '#10b981'};"></div>
                        </div>
                        <div class="bin-footer">
                            <i class="far fa-clock"></i> Last sync: ${timeNow}
                        </div>
                    </div>
                `;
            }

            // Update activity log table
            if (log) {
                log.innerHTML += `
                    <tr>
                        <td><i class="fas fa-qrcode"></i> ${label}</td>
                        <td><strong>${formatPercent(level)}</strong></td>
                        <td>${timeNow}</td>
                        <td><span class="badge" style="background: ${level > 80 ? '#ef4444' : level > 60 ? '#f59e0b' : '#10b981'}; color: white; padding: 4px 8px; border-radius: 20px; font-size: 0.7rem; font-weight: 600;">${level > 80 ? 'CRITICAL' : 'OK'}</span></td>
                    </tr>
                `;
            }

            binIndex++;
        });

        // Update KPI cards
        document.getElementById('total-bins').innerText = data.length;
        document.getElementById('full-bins').innerText = critC;
        document.getElementById('waste-collected').innerText = totalW.toFixed(1) + ' kg';
        document.getElementById('co2-saved').innerText = (totalW * 0.04).toFixed(2) + ' kg';

        // Pulse animation for critical card
        const criticalCard = document.getElementById('critical-card');
        if (criticalCard) {
            if (critC > 0) criticalCard.classList.add('pulse-critical');
            else criticalCard.classList.remove('pulse-critical');
        }

        renderOperationalSnapshot(data);

        // Update waste composition panel from latest bin
        const latestBin = getLatestBin(data) || data.find((bin) => bin.id === 'KLA-01') || data[0];
        if (latestBin && latestBin.waste_composition) {
            const composition = latestBin.waste_composition;
            document.getElementById('recyclable-pct').innerText = formatPercent(composition.recyclable);
            document.getElementById('organic-pct').innerText = formatPercent(composition.organic);
            document.getElementById('hazardous-pct').innerText = formatPercent(composition.hazardous);
        }
    }

    // ============================================
    // FIRESTORE LISTENER
    // ============================================

    console.log("📡 Setting up Firestore listener on 'bins' collection...");

    if (db) {
        const binsRef = collection(db, 'bins');

        try {
            const testDoc = doc(db, 'bins', 'KLA-01');
            const testSnapshot = await getDoc(testDoc);
            if (testSnapshot.exists()) {
                console.log('✅ Direct read successful: KLA-01 exists with data:', testSnapshot.data());
            } else {
                console.log('⚠️ Document KLA-01 does not exist yet. Waiting for Pi to send data...');
            }
        } catch (error) {
            console.error('❌ Firestore read test failed:', error);
            const statusEl = document.getElementById('firestore-status');
            const statusDetailEl = document.getElementById('firestore-status-detail');
            if (statusEl) {
                statusEl.innerText = 'PERMISSION DENIED';
                statusEl.style.color = '#ef4444';
            }
            if (statusDetailEl) {
                statusDetailEl.innerText = 'Permission Denied';
                statusDetailEl.style.color = '#ef4444';
            }
        }

        onSnapshot(
            binsRef,
            async (snapshot) => {
                console.log(`📡 Firestore update: ${snapshot.size} document(s) received`);
                const firestoreStatus = document.getElementById('firestore-status');
                const firestoreStatusDetail = document.getElementById('firestore-status-detail');
                if (firestoreStatus) {
                    firestoreStatus.innerText = `${snapshot.size} BINS`;
                    firestoreStatus.style.color = '#10b981';
                }
                if (firestoreStatusDetail) {
                    firestoreStatusDetail.innerText = `Connected (${snapshot.size} bins)`;
                    firestoreStatusDetail.style.color = '#10b981';
                }

                currentLiveBins = [];
                snapshot.forEach((docSnap) => {
                    const data = docSnap.data();
                    console.log(`   - ${docSnap.id}: level=${data.level}%, status=${data.status}`);
                    currentLiveBins.push({ id: docSnap.id, ...data });
                });

                const cachedMap = await fetchCachedHistoryMap();
                if (cachedMap.size) {
                    currentLiveBins = currentLiveBins.map((bin) => {
                        const cached = cachedMap.get(bin.id) || cachedMap.get(bin.bin_id);
                        if (!cached) return bin;
                        return {
                            ...bin,
                            cycle_history: cached.cycle_history || bin.cycle_history || []
                        };
                    });
                }

                updateUI(currentLiveBins, map, markers);
                renderOperationalSnapshot(currentLiveBins);
                renderPresentationCharts(currentLiveBins);
            },
            (error) => {
                console.error('❌ Firestore listener error:', error);
                const firestoreStatus = document.getElementById('firestore-status');
                const firestoreStatusDetail = document.getElementById('firestore-status-detail');
                if (firestoreStatus) {
                    firestoreStatus.innerText = 'ERROR';
                    firestoreStatus.style.color = '#ef4444';
                }
                if (firestoreStatusDetail) {
                    firestoreStatusDetail.innerText = 'Connection Error';
                    firestoreStatusDetail.style.color = '#ef4444';
                }

                const errorMsg = error.message || '';
                if (errorMsg.includes('permission')) {
                    alert('Firestore permission denied. Please check your security rules in Firebase Console.');
                } else if (errorMsg.includes('network')) {
                    alert('Network error connecting to Firestore. Check your internet connection.');
                }
            }
        );
    } else {
        console.error('❌ Firestore not initialized');
        const firestoreStatus = document.getElementById('firestore-status');
        const firestoreStatusDetail = document.getElementById('firestore-status-detail');
        if (firestoreStatus) firestoreStatus.innerText = 'NOT INITIALIZED';
        if (firestoreStatusDetail) firestoreStatusDetail.innerText = 'Not initialized';
    }

    // ============================================
    // ROUTE OPTIMIZATION BUTTONS
    // ============================================

    const btnOptimize = document.getElementById('btnOptimize');
    const btnClear = document.getElementById('btnClear');

    if (btnOptimize && typeof L !== 'undefined') {
        btnOptimize.onclick = async () => {
            if (currentRoute && map) map.removeLayer(currentRoute);
            clearRouteArrows(map, currentRouteArrows);
            const fullBins = currentLiveBins.filter((bin) => bin.level > 80 && bin.lat && bin.lng).map((bin) => [bin.lat, bin.lng]);
            if (fullBins.length < 1) return alert('✅ System Intelligence: No bins require immediate collection.');

            if (map) {
                const routeStatus = document.getElementById('route-status');
                const routeStatusText = document.getElementById('route-status-text');
                const routeDistance = document.getElementById('route-distance');
                const routeFuel = document.getElementById('route-fuel');

                if (routeStatus) routeStatus.innerText = 'ROUTING...';
                if (routeStatusText) routeStatusText.innerText = 'Calculating road route';

                try {
                    const routeData = await getRoadAlignedRoute(fullBins);
                    currentRoute = drawRouteWithArrows(map, routeData.geometry, currentRouteArrows);

                    // Calculate fuel consumption
                    const fuelNeeded = calculateFuelConsumption(parseFloat(routeData.distance));

                    if (routeStatus) {
                        routeStatus.innerText = 'ROUTE OPTIMIZED';
                        routeStatus.className = 'route-badge bg-success';
                        routeStatus.style.background = '#10b981';
                        routeStatus.style.color = 'white';
                    }
                    if (routeStatusText) routeStatusText.innerText = `Route follows roads • ${routeData.distance} km • ${fuelNeeded} L`;
                    if (routeDistance) routeDistance.innerText = `${routeData.distance} km`;
                    if (routeFuel) routeFuel.innerText = `${fuelNeeded} L`;
                } catch (error) {
                    console.warn('Road routing failed, using fallback polyline:', error);
                    const fallbackDistance = '0';
                    currentRoute = drawRouteWithArrows(map, [[0.3136, 32.5811], ...fullBins], currentRouteArrows, { fallback: true });

                    if (routeStatus) {
                        routeStatus.innerText = 'ROUTE OPTIMIZED';
                        routeStatus.className = 'route-badge bg-success';
                        routeStatus.style.background = '#10b981';
                        routeStatus.style.color = 'white';
                    }
                    if (routeStatusText) routeStatusText.innerText = 'Fallback route used';
                    if (routeDistance) routeDistance.innerText = '--';
                    if (routeFuel) routeFuel.innerText = '--';
                }
            }
        };
    }

    if (btnClear && typeof L !== 'undefined') {
        btnClear.onclick = () => {
            if (currentRoute && map) map.removeLayer(currentRoute);
            clearRouteArrows(map, currentRouteArrows);
            if (map) map.setView([0.3476, 32.5825], 13);

            const routeStatus = document.getElementById('route-status');
            if (routeStatus) {
                routeStatus.innerText = 'Awaiting Optimization';
                routeStatus.className = 'route-badge';
                routeStatus.style.background = '';
                routeStatus.style.color = '';
            }
            const routeStatusText = document.getElementById('route-status-text');
            if (routeStatusText) routeStatusText.innerText = 'Awaiting Optimization';

            const routeDistance = document.getElementById('route-distance');
            if (routeDistance) routeDistance.innerText = '--';

            const routeFuel = document.getElementById('route-fuel');
            if (routeFuel) routeFuel.innerText = '--';
        };
    }
});