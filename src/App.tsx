/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo } from 'react';
import { 
  collection, 
  doc, 
  getDoc, 
  setDoc, 
  onSnapshot, 
  query, 
  where,
  serverTimestamp,
  getDocFromServer,
  getDocs
} from 'firebase/firestore';
import { 
  signInWithPopup, 
  GoogleAuthProvider, 
  onAuthStateChanged, 
  User 
} from 'firebase/auth';
import { db, auth } from './firebase';
import { 
  format, 
  startOfMonth, 
  endOfMonth, 
  eachDayOfInterval, 
  isSameDay, 
  addMonths, 
  subMonths,
  subDays,
  parseISO,
  startOfDay
} from 'date-fns';
import { 
  ChevronLeft, 
  ChevronRight, 
  Save, 
  Calendar as CalendarIcon, 
  History, 
  LogOut,
  TrendingUp,
  Calculator,
  User as UserIcon,
  AlertCircle,
  Store,
  ArrowLeftRight,
  Plus,
  Trash2
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// --- Utilities ---
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// --- Types ---
interface TransferEntry {
  id: string;
  amount: number;
  type: 'plus' | 'minus';
}

interface DailyData {
  morningSales: number;
  morningCustomers: number;
  totalSales: number;
  totalCustomers: number;
  contactLensSales: number;
  allianceReturns: number;
  transferAmount: number;
  priceChangeAmount: number;
  salesAddition: number;
  transfers: TransferEntry[];
}

const DEFAULT_DATA: DailyData = {
  morningSales: 0,
  morningCustomers: 0,
  totalSales: 0,
  totalCustomers: 0,
  contactLensSales: 0,
  allianceReturns: 0,
  transferAmount: 0,
  priceChangeAmount: 0,
  salesAddition: 0,
  transfers: [],
};

// --- Components ---

const ErrorBoundary = ({ children }: { children: React.ReactNode }) => {
  const [hasError, setHasError] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      setHasError(true);
      try {
        const parsed = JSON.parse(event.error.message);
        setErrorMsg(parsed.error || '發生未知錯誤');
      } catch {
        setErrorMsg(event.error?.message || '發生未知錯誤');
      }
    };
    const handleRejection = (event: PromiseRejectionEvent) => {
      setHasError(true);
      try {
        const parsed = JSON.parse(event.reason.message);
        setErrorMsg(parsed.error || '發生未知錯誤');
      } catch {
        setErrorMsg(event.reason.message || '發生未知錯誤');
      }
    };
    window.addEventListener('error', handleError);
    window.addEventListener('unhandledrejection', handleRejection);
    return () => {
      window.removeEventListener('error', handleError);
      window.removeEventListener('unhandledrejection', handleRejection);
    };
  }, []);

  if (hasError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-red-50 p-6">
        <div className="bg-white p-8 rounded-2xl shadow-xl max-w-md w-full text-center border border-red-100">
          <AlertCircle className="w-16 h-16 text-red-500 mx-auto mb-4" />
          <h1 className="text-2xl font-bold text-gray-900 mb-2">出錯了</h1>
          <p className="text-gray-600 mb-6">{errorMsg}</p>
          <button 
            onClick={() => window.location.reload()}
            className="w-full bg-red-500 text-white py-3 rounded-xl font-semibold hover:bg-red-600 transition-colors"
          >
            重新整理
          </button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
};

// --- Constants ---
const MIN_DATE = new Date(2026, 2, 1); // March 2026

export default function App() {
  const [loading, setLoading] = useState(true);
  const [currentDate, setCurrentDate] = useState(() => {
    const yesterday = subDays(new Date(), 1);
    return yesterday < MIN_DATE ? MIN_DATE : yesterday;
  });
  const [viewDate, setViewDate] = useState(new Date());
  const [activeTab, setActiveTab] = useState<'daily' | 'transfers' | 'monthly' | 'history'>('daily');
  const [dailySubTab, setDailySubTab] = useState<'performance' | 'adjustment'>('performance');
  const [monthlySubTab, setMonthlySubTab] = useState<'performance' | 'adjustment'>('performance');
  const [dailyData, setDailyData] = useState<DailyData>(DEFAULT_DATA);
  const [viewMonthlyData, setViewMonthlyData] = useState<Record<string, DailyData>>({});
  const [currentMonthlyData, setCurrentMonthlyData] = useState<Record<string, DailyData>>({});
  const [monthlyGoal, setMonthlyGoal] = useState<number>(0);
  const [previousBalance, setPreviousBalance] = useState<number>(0);
  const [currentMonthPreviousBalance, setCurrentMonthPreviousBalance] = useState<number>(0);
  const [isSaving, setIsSaving] = useState(false);
  const [isSavingGoal, setIsSavingGoal] = useState(false);

  // --- Initialization ---
  useEffect(() => {
    const init = async () => {
      await testConnection();
      setLoading(false);
    };
    init();
  }, []);

  const testConnection = async () => {
    try {
      // Use a timeout for the connection test
      const connectionPromise = getDocFromServer(doc(db, 'test', 'connection'));
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('連線逾時，請檢查 Firebase 設定或網路連線')), 5000)
      );
      
      await Promise.race([connectionPromise, timeoutPromise]);
    } catch (error) {
      console.error("Firebase Connection Error:", error);
      if (error instanceof Error) {
        if (error.message.includes('the client is offline') || error.message.includes('逾時')) {
          throw new Error(JSON.stringify({ error: "無法連線至資料庫。請確認您的 Firebase 金鑰是否正確，且資料庫 ID 是否為 (default)。" }));
        }
        if (error.message.includes('Missing or insufficient permissions')) {
          throw new Error(JSON.stringify({ error: "權限不足。請確認 Firestore 安全規則已正確部署，並允許讀取 test/connection 路徑。" }));
        }
      }
      throw error;
    }
  };

  const handleLogout = () => {
    // No logout needed for guest mode
    alert("目前為免登入模式");
  };

  // --- Data Sync ---
  useEffect(() => {
    const dateStr = format(currentDate, 'yyyy-MM-dd');
    const docRef = doc(db, 'dailyReports', dateStr);

    const unsubscribe = onSnapshot(docRef, (snapshot) => {
      if (snapshot.exists()) {
        setDailyData(snapshot.data() as DailyData);
      } else {
        setDailyData(DEFAULT_DATA);
      }
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, `dailyReports/${dateStr}`);
    });

    return () => unsubscribe();
  }, [currentDate]);

  useEffect(() => {
    const monthStr = format(currentDate, 'yyyy-MM');
    const goalRef = doc(db, 'monthlyGoals', monthStr);

    const unsubscribe = onSnapshot(goalRef, (snapshot) => {
      if (snapshot.exists()) {
        setCurrentMonthPreviousBalance(snapshot.data().previousBalance || 0);
      } else {
        setCurrentMonthPreviousBalance(0);
      }
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, `monthlyGoals/${monthStr}`);
    });

    return () => unsubscribe();
  }, [currentDate]);

  useEffect(() => {
    const monthStr = format(viewDate, 'yyyy-MM');
    const goalRef = doc(db, 'monthlyGoals', monthStr);

    const unsubscribe = onSnapshot(goalRef, (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.data();
        setMonthlyGoal(data.psdGoal || 0);
        setPreviousBalance(data.previousBalance || 0);
      } else {
        setMonthlyGoal(0);
        setPreviousBalance(0);
      }
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, `monthlyGoals/${monthStr}`);
    });

    return () => unsubscribe();
  }, [viewDate]);

  // Auto-calculate previous month's balance if not set
  useEffect(() => {
    const checkAndAutoFill = async () => {
      const monthStr = format(viewDate, 'yyyy-MM');
      const goalRef = doc(db, 'monthlyGoals', monthStr);
      const snap = await getDoc(goalRef);
      
      // Only auto-fill if the current month's previousBalance is not set in Firestore
      if (!snap.exists() || snap.data().previousBalance === undefined) {
        const prevMonth = subMonths(viewDate, 1);
        const prevMonthStr = format(prevMonth, 'yyyy-MM');
        
        // Fetch previous month's goal/balance
        const prevGoalRef = doc(db, 'monthlyGoals', prevMonthStr);
        const prevGoalSnap = await getDoc(prevGoalRef);
        const prevStartBal = prevGoalSnap.exists() ? (prevGoalSnap.data().previousBalance || 0) : 0;
        
        // Fetch previous month's daily reports
        const start = startOfMonth(prevMonth);
        const end = endOfMonth(prevMonth);
        const q = query(
          collection(db, 'dailyReports'),
          where('__name__', '>=', format(start, 'yyyy-MM-dd')),
          where('__name__', '<=', format(end, 'yyyy-MM-dd'))
        );
        
        const dailySnap = await getDocs(q);
        let prevMonthChange = 0;
        dailySnap.forEach(doc => {
          const d = doc.data() as DailyData;
          prevMonthChange += (d.allianceReturns + d.transferAmount + d.priceChangeAmount - d.totalSales - d.salesAddition);
        });
        
        const calculatedPrevEndBal = prevStartBal + prevMonthChange;
        if (calculatedPrevEndBal !== 0) {
          setPreviousBalance(calculatedPrevEndBal);
        }
      }
    };

    if (!loading) {
      checkAndAutoFill();
    }
  }, [viewDate, loading]);

  useEffect(() => {
    const start = startOfMonth(currentDate);
    const end = endOfMonth(currentDate);
    const dateStrStart = format(start, 'yyyy-MM-dd');
    const dateStrEnd = format(end, 'yyyy-MM-dd');

    const q = query(
      collection(db, 'dailyReports'),
      where('__name__', '>=', dateStrStart),
      where('__name__', '<=', dateStrEnd)
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const data: Record<string, DailyData> = {};
      snapshot.docs.forEach(doc => {
        data[doc.id] = doc.data() as DailyData;
      });
      setCurrentMonthlyData(data);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'dailyReports');
    });

    return () => unsubscribe();
  }, [currentDate]);

  useEffect(() => {
    const start = startOfMonth(viewDate);
    const end = endOfMonth(viewDate);
    const dateStrStart = format(start, 'yyyy-MM-dd');
    const dateStrEnd = format(end, 'yyyy-MM-dd');

    const q = query(
      collection(db, 'dailyReports'),
      where('__name__', '>=', dateStrStart),
      where('__name__', '<=', dateStrEnd)
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const data: Record<string, DailyData> = {};
      snapshot.docs.forEach(doc => {
        data[doc.id] = doc.data() as DailyData;
      });
      setViewMonthlyData(data);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'dailyReports');
    });

    return () => unsubscribe();
  }, [viewDate]);

  const handleSave = async () => {
    setIsSaving(true);
    const dateStr = format(currentDate, 'yyyy-MM-dd');
    try {
      // Calculate transferAmount from transfers array before saving
      const transferAmount = (dailyData.transfers || []).reduce((sum, t) => {
        return sum + (t.amount * (t.type === 'plus' ? 1 : -1));
      }, 0);

      const savePromise = setDoc(doc(db, 'dailyReports', dateStr), {
        ...dailyData,
        transferAmount,
        updatedAt: serverTimestamp()
      });
      
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('儲存逾時，請檢查網路連線或 Firebase 設定')), 8000)
      );

      await Promise.race([savePromise, timeoutPromise]);
      alert('數據已成功儲存！');
    } catch (error) {
      console.error("Save Error:", error);
      handleFirestoreError(error, OperationType.WRITE, `dailyReports/${dateStr}`);
      alert(error instanceof Error ? error.message : '儲存失敗，請稍後再試');
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveGoal = async (goal: number, prevBal: number) => {
    setIsSavingGoal(true);
    const monthStr = format(viewDate, 'yyyy-MM');
    try {
      const savePromise = setDoc(doc(db, 'monthlyGoals', monthStr), {
        psdGoal: goal,
        previousBalance: prevBal,
        updatedAt: serverTimestamp()
      }, { merge: true });
      
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('設定逾時，請檢查網路連線或 Firebase 設定')), 8000)
      );

      await Promise.race([savePromise, timeoutPromise]);
      alert('目標與帳面已成功設定！');
    } catch (error) {
      console.error("Save Goal Error:", error);
      handleFirestoreError(error, OperationType.WRITE, `monthlyGoals/${monthStr}`);
      alert(error instanceof Error ? error.message : '設定失敗，請稍後再試');
    } finally {
      setIsSavingGoal(false);
    }
  };

  // --- Calculations ---
  const calculated = useMemo(() => {
    const { morningSales, morningCustomers, totalSales, totalCustomers, contactLensSales, allianceReturns, priceChangeAmount, salesAddition, transfers } = dailyData;
    
    const eveningSales = totalSales - morningSales;
    const eveningCustomers = totalCustomers - morningCustomers;
    
    const morningAOV = morningCustomers > 0 ? morningSales / morningCustomers : 0;
    const eveningAOV = eveningCustomers > 0 ? eveningSales / eveningCustomers : 0;
    const actualPSD = totalSales - contactLensSales;
    const totalAOV = totalCustomers > 0 ? actualPSD / totalCustomers : 0;

    // Calculate current day's transfer amount from transfers array
    const currentTransferAmount = (transfers || []).reduce((sum, t) => {
      return sum + (t.amount * (t.type === 'plus' ? 1 : -1));
    }, 0);
    
    // Book Total Calculation (Cumulative for the current month)
    const dateKey = format(currentDate, 'yyyy-MM-dd');
    // Use the calculated currentTransferAmount for the current day in mergedData
    const currentDayDataWithCalculatedTransfers = { ...dailyData, transferAmount: currentTransferAmount };
    const mergedData = { ...currentMonthlyData, [dateKey]: currentDayDataWithCalculatedTransfers };
    
    let cumulativeBookTotal = currentMonthPreviousBalance;
    const allDates = Object.keys(mergedData).sort();
    
    allDates.forEach(date => {
      if (date <= dateKey) {
        const d = mergedData[date] as DailyData;
        // Formula: 結盟進退貨 + 調撥 + 變價 - 銷貨收入(整日營業額) - 銷貨加項
        cumulativeBookTotal += (d.allianceReturns + d.transferAmount + d.priceChangeAmount - d.totalSales - d.salesAddition);
      }
    });

    return {
      eveningSales,
      eveningCustomers,
      morningAOV,
      eveningAOV,
      totalAOV,
      actualPSD,
      currentTransferAmount,
      bookTotal: cumulativeBookTotal
    };
  }, [dailyData, currentMonthlyData, currentDate, currentMonthPreviousBalance]);

  const monthlyStats = useMemo(() => {
    let totalPSD = 0;
    let totalCustomers = 0;
    
    // Merge current daily data into the monthly data set for real-time calculation
    // ONLY if the current date being edited belongs to the month being viewed
    const dateKey = format(currentDate, 'yyyy-MM-dd');
    const isSameMonth = format(currentDate, 'yyyy-MM') === format(viewDate, 'yyyy-MM');
    const mergedData = isSameMonth ? { ...viewMonthlyData, [dateKey]: dailyData } : viewMonthlyData;
    
    // Only count days that have sales data (to avoid dividing by 31 if only 1 day is filled)
    const activeEntries = (Object.values(mergedData) as DailyData[]).filter(d => d.totalSales > 0);
    const daysCount = activeEntries.length;
    
    activeEntries.forEach(d => {
      totalPSD += (d.totalSales - d.contactLensSales);
      totalCustomers += d.totalCustomers;
    });
    
    const goal = monthlyGoal;
    const monthlyAverage = daysCount > 0 ? totalPSD / daysCount : 0;
    const monthlyAOV = totalCustomers > 0 ? totalPSD / totalCustomers : 0;
    const achievement = goal > 0 ? (monthlyAverage / goal) * 100 : 0;
    
    return { totalPSD, totalCustomers, goal, achievement, monthlyAverage, monthlyAOV, daysWithData: daysCount };
  }, [viewMonthlyData, dailyData, monthlyGoal, currentDate, viewDate]);

  return (
    <ErrorBoundary>
      {loading ? (
        <div className="min-h-screen flex items-center justify-center bg-gray-50">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-airbnb"></div>
        </div>
      ) : (
        <div className="min-h-screen bg-gray-50 pb-24 font-sans text-gray-900">
          {/* Header */}
          <header className="bg-white px-6 py-5 flex items-center justify-between shadow-sm sticky top-0 z-10">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-[28%] flex items-center justify-center shadow-lg shadow-airbnb/25 overflow-hidden">
                <img 
                  src="https://lh3.googleusercontent.com/d/1jEp5fOipS-4qbaWSvwHfz-09icjyzS_y?v=2" 
                  alt="App Icon" 
                  className="w-full h-full object-cover"
                  referrerPolicy="no-referrer"
                />
              </div>
              <div>
                <h1 className="text-xl font-bold tracking-tight leading-none">營運管理</h1>
                <p className="text-[10px] text-gray-400 font-bold uppercase tracking-[0.2em] mt-1">Store Management</p>
              </div>
            </div>
            <button onClick={handleLogout} className="p-2 text-gray-400">
              <UserIcon className="w-6 h-6" />
            </button>
          </header>

          <main className="p-4 max-w-2xl mx-auto">
            <AnimatePresence mode="wait">
              {activeTab === 'daily' && (
                <motion.div 
                  key="daily"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  className="space-y-6"
                >
                {/* Date Selector */}
                <div className="bg-white p-4 rounded-2xl shadow-sm flex items-center justify-between">
                  <button 
                    onClick={() => {
                      const prev = new Date(currentDate);
                      prev.setDate(prev.getDate() - 1);
                      if (prev >= startOfDay(MIN_DATE)) {
                        setCurrentDate(prev);
                      }
                    }} 
                    disabled={isSameDay(currentDate, startOfDay(MIN_DATE))}
                    className={cn(
                      "p-2 rounded-lg transition-colors",
                      isSameDay(currentDate, startOfDay(MIN_DATE)) ? "bg-gray-50 text-gray-200" : "bg-gray-50 text-gray-600"
                    )}
                  >
                    <ChevronLeft className="w-5 h-5" />
                  </button>
                  <div className="text-center">
                    <div className="text-sm text-gray-400 font-medium">{format(currentDate, 'yyyy年MM月')}</div>
                    <div className="text-lg font-bold">{format(currentDate, 'dd日 (EEEE)')}</div>
                  </div>
                  <button onClick={() => setCurrentDate(new Date(currentDate.setDate(currentDate.getDate() + 1)))} className="p-2 bg-gray-50 rounded-lg">
                    <ChevronRight className="w-5 h-5" />
                  </button>
                </div>

                {/* Sub-tabs for Daily Entry */}
                <div className="flex bg-white p-1.5 rounded-2xl shadow-sm border border-gray-100">
                  <button 
                    onClick={() => setDailySubTab('performance')}
                    className={cn(
                      "flex-1 py-3 rounded-xl font-bold text-sm transition-all",
                      dailySubTab === 'performance' ? "bg-airbnb text-white shadow-md" : "text-gray-400"
                    )}
                  >
                    1. 營運績效看板
                  </button>
                  <button 
                    onClick={() => setDailySubTab('adjustment')}
                    className={cn(
                      "flex-1 py-3 rounded-xl font-bold text-sm transition-all",
                      dailySubTab === 'adjustment' ? "bg-gray-800 text-white shadow-md" : "text-gray-400"
                    )}
                  >
                    2. 盤前帳面調節
                  </button>
                </div>

                <AnimatePresence mode="wait">
                  {dailySubTab === 'performance' ? (
                    <motion.section 
                      key="performance"
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: 10 }}
                      className="bg-white rounded-3xl shadow-sm overflow-hidden border border-gray-100"
                    >
                      <div className="bg-airbnb px-6 py-4 flex items-center gap-2">
                        <Calculator className="w-5 h-5 text-white" />
                        <h2 className="text-white font-bold">營運績效看板</h2>
                      </div>
                      <div className="p-6 space-y-4">
                        <div className="grid grid-cols-2 gap-4">
                          <InputGroup label="早班營業額" value={dailyData.morningSales} onChange={v => setDailyData({...dailyData, morningSales: v})} />
                          <InputGroup label="早班來客數" value={dailyData.morningCustomers} onChange={v => setDailyData({...dailyData, morningCustomers: v})} />
                          <InputGroup label="整日營業額" value={dailyData.totalSales} onChange={v => setDailyData({...dailyData, totalSales: v})} />
                          <InputGroup label="整日來客數" value={dailyData.totalCustomers} onChange={v => setDailyData({...dailyData, totalCustomers: v})} />
                          <InputGroup label="隱形眼鏡營業額" value={dailyData.contactLensSales} onChange={v => setDailyData({...dailyData, contactLensSales: v})} />
                        </div>

                        <div className="mt-6 bg-gray-50 rounded-2xl p-4 space-y-4">
                          <div className="space-y-2">
                            <div className="text-[10px] font-bold text-airbnb uppercase tracking-widest mb-1">早班數據</div>
                            <ResultRow label="早班營業額" value={dailyData.morningSales} />
                            <ResultRow label="早班來客數" value={dailyData.morningCustomers} />
                            <ResultRow label="早班客單價" value={calculated.morningAOV} isCurrency />
                          </div>
                          
                          <div className="h-px bg-gray-200" />
                          
                          <div className="space-y-2">
                            <div className="text-[10px] font-bold text-gray-800 uppercase tracking-widest mb-1">晚班數據</div>
                            <ResultRow label="晚班營業額" value={calculated.eveningSales} />
                            <ResultRow label="晚班來客數" value={calculated.eveningCustomers} />
                            <ResultRow label="晚班客單價" value={calculated.eveningAOV} isCurrency />
                          </div>

                          <div className="h-px bg-gray-200" />

                          <div className="space-y-2">
                            <div className="text-[10px] font-bold text-green-600 uppercase tracking-widest mb-1">整日數據 (扣除隱眼)</div>
                            <ResultRow label="整日營業額" value={calculated.actualPSD} highlight />
                            <ResultRow label="整日來客數" value={dailyData.totalCustomers} />
                            <ResultRow label="整日客單價" value={calculated.totalAOV} isCurrency />
                          </div>

                          <div className="h-px bg-airbnb/20 border-dashed border-t" />

                          <div className="space-y-2">
                            <div className="text-[10px] font-bold text-orange-600 uppercase tracking-widest mb-1">當月累積 (MTD)</div>
                            <ResultRow label="當月累積營業額" value={monthlyStats.totalPSD} highlight color="text-orange-600" />
                            <ResultRow label="當月累積來客" value={monthlyStats.totalCustomers} />
                          </div>

                          <div className="h-px bg-gray-200" />

                          <div className="space-y-2">
                            <div className="text-[10px] font-bold text-purple-600 uppercase tracking-widest mb-1">績效指標</div>
                            <ResultRow label="每月平均 (PSD)" value={monthlyStats.monthlyAverage} isCurrency />
                            <ResultRow label="當月業績達成率" value={monthlyStats.achievement} highlight color="text-purple-600" isPercent />
                          </div>
                        </div>
                      </div>
                    </motion.section>
                  ) : (
                    <motion.section 
                      key="adjustment"
                      initial={{ opacity: 0, x: 10 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -10 }}
                      className="bg-white rounded-3xl shadow-sm overflow-hidden border border-gray-100"
                    >
                      <div className="bg-gray-800 px-6 py-4 flex items-center gap-2">
                        <History className="w-5 h-5 text-white" />
                        <h2 className="text-white font-bold">盤前帳面調節表</h2>
                      </div>
                      <div className="p-6 space-y-4">
                        <div className="grid grid-cols-1 gap-4">
                          <InputGroup label="結盟進退貨" value={dailyData.allianceReturns} onChange={v => setDailyData({...dailyData, allianceReturns: v})} />
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div className="space-y-1.5">
                              <label className="text-[11px] font-bold text-gray-400 uppercase tracking-wider ml-1">調撥金額 (由每日調撥自動帶入)</label>
                              <div className={cn(
                                "w-full bg-gray-100 border-2 border-transparent rounded-xl px-4 py-3 text-lg font-bold text-gray-500",
                                calculated.currentTransferAmount < 0 && "text-red-500",
                                calculated.currentTransferAmount > 0 && "text-green-500"
                              )}>
                                {calculated.currentTransferAmount > 0 ? '+' : ''}{calculated.currentTransferAmount.toLocaleString()}
                              </div>
                            </div>
                            <SignedInputGroup label="變價金額" value={dailyData.priceChangeAmount} onChange={v => setDailyData({...dailyData, priceChangeAmount: v})} />
                          </div>
                        </div>
                        <div className="bg-gray-50 p-4 rounded-xl flex justify-between items-center">
                          <span className="text-gray-500 text-sm font-medium">銷貨收入 (整日營業額)</span>
                          <span className="font-bold text-lg">{dailyData.totalSales.toLocaleString()}</span>
                        </div>
                        <div className="grid grid-cols-1">
                          <InputGroup label="銷貨加項" value={dailyData.salesAddition} onChange={v => setDailyData({...dailyData, salesAddition: v})} />
                        </div>
                        <div className="mt-4 bg-gray-50 rounded-2xl p-4">
                          <ResultRow label="帳面合計 (累計)" value={calculated.bookTotal} highlight color="text-gray-800" />
                        </div>
                      </div>
                    </motion.section>
                  )}
                </AnimatePresence>

                <button 
                  onClick={handleSave}
                  disabled={isSaving}
                  className={cn(
                    "w-full py-4 rounded-2xl font-bold text-lg shadow-lg flex items-center justify-center gap-2 transition-all active:scale-95",
                    isSaving ? "bg-gray-400" : "bg-airbnb text-white hover:bg-airbnb/90"
                  )}
                >
                  {isSaving ? (
                    <div className="animate-spin rounded-full h-5 w-5 border-t-2 border-white"></div>
                  ) : (
                    <>
                      <Save className="w-6 h-6" />
                      儲存當日數據
                    </>
                  )}
                </button>
              </motion.div>
            )}

            {activeTab === 'transfers' && (
              <motion.div 
                key="transfers"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="space-y-6"
              >
                {/* Date Selector (Shared with Daily) */}
                <div className="bg-white p-4 rounded-2xl shadow-sm flex items-center justify-between">
                  <button 
                    onClick={() => {
                      const prev = new Date(currentDate);
                      prev.setDate(prev.getDate() - 1);
                      if (prev >= startOfDay(MIN_DATE)) {
                        setCurrentDate(prev);
                      }
                    }} 
                    disabled={isSameDay(currentDate, startOfDay(MIN_DATE))}
                    className={cn(
                      "p-2 rounded-lg transition-colors",
                      isSameDay(currentDate, startOfDay(MIN_DATE)) ? "bg-gray-50 text-gray-200" : "bg-gray-50 text-gray-600"
                    )}
                  >
                    <ChevronLeft className="w-5 h-5" />
                  </button>
                  <div className="text-center">
                    <div className="text-sm text-gray-400 font-medium">{format(currentDate, 'yyyy年MM月')}</div>
                    <div className="text-lg font-bold">{format(currentDate, 'dd日 (EEEE)')}</div>
                  </div>
                  <button onClick={() => setCurrentDate(new Date(currentDate.setDate(currentDate.getDate() + 1)))} className="p-2 bg-gray-50 rounded-lg">
                    <ChevronRight className="w-5 h-5" />
                  </button>
                </div>

                <div className="bg-white rounded-3xl shadow-sm overflow-hidden border border-gray-100">
                  <div className="bg-airbnb px-6 py-4 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <ArrowLeftRight className="w-5 h-5 text-white" />
                      <h2 className="text-white font-bold">每日調撥明細</h2>
                    </div>
                    <button 
                      onClick={() => {
                        const newTransfer: TransferEntry = {
                          id: Math.random().toString(36).substr(2, 9),
                          amount: 0,
                          type: 'plus'
                        };
                        setDailyData({
                          ...dailyData,
                          transfers: [...(dailyData.transfers || []), newTransfer]
                        });
                      }}
                      className="bg-white/20 hover:bg-white/30 text-white p-2 rounded-xl transition-colors"
                    >
                      <Plus className="w-5 h-5" />
                    </button>
                  </div>

                  <div className="p-6 space-y-4">
                    {(dailyData.transfers || []).length === 0 ? (
                      <div className="text-center py-10 text-gray-400 italic">
                        尚無調撥紀錄，點擊右上角「+」新增
                      </div>
                    ) : (
                      <div className="space-y-4">
                        {(dailyData.transfers || []).map((transfer, index) => (
                          <div key={transfer.id} className="bg-gray-50 p-4 rounded-2xl space-y-3 relative group">
                            <button 
                              onClick={() => {
                                const newTransfers = dailyData.transfers.filter(t => t.id !== transfer.id);
                                setDailyData({ ...dailyData, transfers: newTransfers });
                              }}
                              className="absolute -top-2 -right-2 bg-white text-red-500 p-1.5 rounded-full shadow-sm border border-red-50 opacity-0 group-hover:opacity-100 transition-opacity"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                            
                            <div className="flex gap-3">
                              <button 
                                onClick={() => {
                                  const newTransfers = [...dailyData.transfers];
                                  newTransfers[index].type = transfer.type === 'plus' ? 'minus' : 'plus';
                                  setDailyData({ ...dailyData, transfers: newTransfers });
                                }}
                                className={cn(
                                  "w-14 h-12 rounded-xl font-bold text-xl transition-all border-2 flex items-center justify-center shrink-0",
                                  transfer.type === 'minus' 
                                    ? "bg-red-50 border-red-100 text-red-500" 
                                    : "bg-green-50 border-green-100 text-green-500"
                                )}
                              >
                                {transfer.type === 'plus' ? '+' : '-'}
                              </button>
                              <input 
                                type="number"
                                inputMode="decimal"
                                value={transfer.amount || ''}
                                onChange={e => {
                                  const newTransfers = [...dailyData.transfers];
                                  newTransfers[index].amount = parseFloat(e.target.value) || 0;
                                  setDailyData({ ...dailyData, transfers: newTransfers });
                                }}
                                placeholder="金額"
                                className="flex-1 bg-white border-2 border-transparent focus:border-airbnb rounded-xl px-4 py-2 font-bold outline-none"
                              />
                            </div>
                          </div>
                        ))}

                        <div className="pt-4 border-t border-gray-100 flex justify-between items-center">
                          <span className="text-gray-400 font-bold text-sm uppercase tracking-wider">今日小計</span>
                          <span className={cn(
                            "text-xl font-black tabular-nums",
                            calculated.currentTransferAmount > 0 ? "text-green-500" : 
                            calculated.currentTransferAmount < 0 ? "text-red-500" : "text-gray-800"
                          )}>
                            {calculated.currentTransferAmount > 0 ? '+' : ''}
                            {calculated.currentTransferAmount.toLocaleString()}
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <button 
                  onClick={handleSave}
                  disabled={isSaving}
                  className={cn(
                    "w-full py-4 rounded-2xl font-bold text-lg shadow-lg flex items-center justify-center gap-2 transition-all active:scale-95",
                    isSaving ? "bg-gray-400" : "bg-airbnb text-white hover:bg-airbnb/90"
                  )}
                >
                  {isSaving ? (
                    <div className="animate-spin rounded-full h-5 w-5 border-t-2 border-white"></div>
                  ) : (
                    <>
                      <Save className="w-6 h-6" />
                      儲存調撥紀錄
                    </>
                  )}
                </button>
              </motion.div>
            )}

            {activeTab === 'monthly' && (
              <motion.div 
                key="monthly"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="space-y-6"
              >
                <div className="bg-white p-4 rounded-2xl shadow-sm flex items-center justify-between">
                  <button 
                    onClick={() => {
                      const prev = subMonths(viewDate, 1);
                      if (prev >= startOfMonth(MIN_DATE)) {
                        setViewDate(prev);
                      }
                    }} 
                    disabled={format(viewDate, 'yyyy-MM') === format(MIN_DATE, 'yyyy-MM')}
                    className={cn(
                      "p-2 rounded-lg transition-colors",
                      format(viewDate, 'yyyy-MM') === format(MIN_DATE, 'yyyy-MM') ? "bg-gray-50 text-gray-200" : "bg-gray-50 text-gray-600"
                    )}
                  >
                    <ChevronLeft className="w-5 h-5" />
                  </button>
                  <div className="text-lg font-bold">{format(viewDate, 'yyyy年 MM月')}</div>
                  <button onClick={() => setViewDate(addMonths(viewDate, 1))} className="p-2 bg-gray-50 rounded-lg">
                    <ChevronRight className="w-5 h-5" />
                  </button>
                </div>

                {/* Monthly Goal & Balance Setting */}
                <div className="bg-white p-6 rounded-3xl shadow-sm border border-gray-100 space-y-6">
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wider">本月 PSD 目標設定</h3>
                      {isSavingGoal && <div className="animate-spin rounded-full h-4 w-4 border-t-2 border-airbnb"></div>}
                    </div>
                    <div className="flex gap-3">
                      <input 
                        type="number" 
                        inputMode="decimal"
                        value={monthlyGoal || ''} 
                        onChange={e => {
                          const val = parseFloat(e.target.value) || 0;
                          setMonthlyGoal(val);
                        }}
                        onBlur={() => handleSaveGoal(monthlyGoal, previousBalance)}
                        placeholder="請輸入目標金額"
                        className="flex-1 bg-gray-50 border-2 border-transparent focus:border-airbnb focus:bg-white rounded-xl px-4 py-3 text-lg font-bold transition-all outline-none"
                      />
                    </div>
                  </div>

                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wider">上月累積帳面 (期初)</h3>
                    </div>
                    <div className="flex gap-3">
                      <input 
                        type="number" 
                        inputMode="decimal"
                        value={previousBalance || ''} 
                        onChange={e => {
                          const val = parseFloat(e.target.value) || 0;
                          setPreviousBalance(val);
                        }}
                        onBlur={() => handleSaveGoal(monthlyGoal, previousBalance)}
                        placeholder="請輸入上月累積帳面"
                        className="flex-1 bg-gray-50 border-2 border-transparent focus:border-airbnb focus:bg-white rounded-xl px-4 py-3 text-lg font-bold transition-all outline-none"
                      />
                      <button 
                        onClick={() => handleSaveGoal(monthlyGoal, previousBalance)}
                        className="bg-airbnb text-white px-6 rounded-xl font-bold shadow-md active:scale-95 transition-all"
                      >
                        儲存設定
                      </button>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="bg-white p-6 rounded-3xl shadow-sm border border-gray-100">
                    <div className="text-gray-400 text-xs font-bold uppercase tracking-wider mb-1">累計 PSD</div>
                    <div className="text-2xl font-black text-airbnb">{monthlyStats.totalPSD.toLocaleString()}</div>
                  </div>
                  <div className="bg-white p-6 rounded-3xl shadow-sm border border-gray-100">
                    <div className="text-gray-400 text-xs font-bold uppercase tracking-wider mb-1">累計來客</div>
                    <div className="text-2xl font-black text-purple-600">{monthlyStats.totalCustomers.toLocaleString()}</div>
                  </div>
                  <div className="bg-white p-6 rounded-3xl shadow-sm border border-gray-100">
                    <div className="text-gray-400 text-xs font-bold uppercase tracking-wider mb-1">每月平均 PSD</div>
                    <div className="text-2xl font-black text-orange-600">{Math.round(monthlyStats.monthlyAverage).toLocaleString()}</div>
                  </div>
                  <div className="bg-white p-6 rounded-3xl shadow-sm border border-gray-100">
                    <div className="text-gray-400 text-xs font-bold uppercase tracking-wider mb-1">達成率</div>
                    <div className="text-2xl font-black text-green-600">{monthlyStats.achievement.toFixed(1)}%</div>
                  </div>
                  <div className="bg-white p-6 rounded-3xl shadow-sm border border-gray-100">
                    <div className="text-gray-400 text-xs font-bold uppercase tracking-wider mb-1">平均客單價</div>
                    <div className="text-2xl font-black text-blue-600">{Math.round(monthlyStats.monthlyAOV).toLocaleString()}</div>
                  </div>
                </div>

                {/* Sub-tabs for Monthly Overview */}
                <div className="flex bg-white p-1.5 rounded-2xl shadow-sm border border-gray-100">
                  <button 
                    onClick={() => setMonthlySubTab('performance')}
                    className={cn(
                      "flex-1 py-3 rounded-xl font-bold text-sm transition-all",
                      monthlySubTab === 'performance' ? "bg-airbnb text-white shadow-md" : "text-gray-400"
                    )}
                  >
                    營運績效
                  </button>
                  <button 
                    onClick={() => setMonthlySubTab('adjustment')}
                    className={cn(
                      "flex-1 py-3 rounded-xl font-bold text-sm transition-all",
                      monthlySubTab === 'adjustment' ? "bg-gray-800 text-white shadow-md" : "text-gray-400"
                    )}
                  >
                    帳面調節
                  </button>
                </div>

                <div className="bg-white rounded-3xl shadow-sm overflow-hidden border border-gray-100">
                  <div className="overflow-x-auto">
                    {(() => {
                      const dateKey = format(currentDate, 'yyyy-MM-dd');
                      const isSameMonth = format(currentDate, 'yyyy-MM') === format(viewDate, 'yyyy-MM');
                      const mergedData = isSameMonth ? { ...viewMonthlyData, [dateKey]: dailyData } : viewMonthlyData;
                      const days = eachDayOfInterval({ start: startOfMonth(viewDate), end: endOfMonth(viewDate) });

                      if (monthlySubTab === 'performance') {
                        return (
                          <table className="w-full text-left border-collapse">
                            <thead>
                              <tr className="bg-gray-50 border-b border-gray-100">
                                <th className="px-4 py-3 text-[10px] font-bold text-gray-400 uppercase whitespace-nowrap">日期</th>
                                <th className="px-4 py-3 text-[10px] font-bold text-gray-400 uppercase whitespace-nowrap">早班額</th>
                                <th className="px-4 py-3 text-[10px] font-bold text-gray-400 uppercase whitespace-nowrap">早班客</th>
                                <th className="px-4 py-3 text-[10px] font-bold text-gray-400 uppercase whitespace-nowrap">晚班額</th>
                                <th className="px-4 py-3 text-[10px] font-bold text-gray-400 uppercase whitespace-nowrap">晚班客</th>
                                <th className="px-4 py-3 text-[10px] font-bold text-gray-400 uppercase whitespace-nowrap">整日額</th>
                                <th className="px-4 py-3 text-[10px] font-bold text-gray-400 uppercase whitespace-nowrap">整日客</th>
                                <th className="px-4 py-3 text-[10px] font-bold text-gray-400 uppercase whitespace-nowrap">隱眼</th>
                                <th className="px-4 py-3 text-[10px] font-bold text-airbnb uppercase whitespace-nowrap">PSD</th>
                              </tr>
                            </thead>
                            <tbody>
                              {days.map(day => {
                                const dStr = format(day, 'yyyy-MM-dd');
                                const data = mergedData[dStr] as DailyData | undefined;
                                const eveningSales = data ? data.totalSales - data.morningSales : 0;
                                const eveningCustomers = data ? data.totalCustomers - data.morningCustomers : 0;
                                const actualPSD = data ? data.totalSales - data.contactLensSales : 0;
                                
                                return (
                                  <tr 
                                    key={dStr} 
                                    className={cn("border-b border-gray-50 active:bg-gray-50", isSameDay(day, new Date()) && "bg-airbnb/5")}
                                    onClick={() => {
                                      setCurrentDate(day);
                                      setActiveTab('daily');
                                    }}
                                  >
                                    <td className="px-4 py-3 text-xs font-bold text-gray-600 whitespace-nowrap">{format(day, 'd')}日</td>
                                    <td className="px-4 py-3 text-xs text-gray-500 tabular-nums">{data?.morningSales.toLocaleString() || '-'}</td>
                                    <td className="px-4 py-3 text-xs text-gray-500 tabular-nums">{data?.morningCustomers.toLocaleString() || '-'}</td>
                                    <td className="px-4 py-3 text-xs text-gray-500 tabular-nums">{data ? eveningSales.toLocaleString() : '-'}</td>
                                    <td className="px-4 py-3 text-xs text-gray-500 tabular-nums">{data ? eveningCustomers.toLocaleString() : '-'}</td>
                                    <td className="px-4 py-3 text-xs text-gray-500 tabular-nums">{data?.totalSales.toLocaleString() || '-'}</td>
                                    <td className="px-4 py-3 text-xs text-gray-500 tabular-nums">{data?.totalCustomers.toLocaleString() || '-'}</td>
                                    <td className="px-4 py-3 text-xs text-gray-500 tabular-nums">{data?.contactLensSales.toLocaleString() || '-'}</td>
                                    <td className="px-4 py-3 text-xs font-bold text-airbnb tabular-nums">{data ? actualPSD.toLocaleString() : '-'}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        );
                      } else {
                        let cumulative = previousBalance;
                        return (
                          <table className="w-full text-left border-collapse">
                            <thead>
                              <tr className="bg-gray-50 border-b border-gray-100">
                                <th className="px-4 py-3 text-[10px] font-bold text-gray-400 uppercase whitespace-nowrap">日期</th>
                                <th className="px-4 py-3 text-[10px] font-bold text-gray-400 uppercase whitespace-nowrap">進退貨</th>
                                <th className="px-4 py-3 text-[10px] font-bold text-gray-400 uppercase whitespace-nowrap">調撥</th>
                                <th className="px-4 py-3 text-[10px] font-bold text-gray-400 uppercase whitespace-nowrap">變價</th>
                                <th className="px-4 py-3 text-[10px] font-bold text-gray-400 uppercase whitespace-nowrap">銷貨收入</th>
                                <th className="px-4 py-3 text-[10px] font-bold text-gray-400 uppercase whitespace-nowrap">銷貨加項</th>
                                <th className="px-4 py-3 text-[10px] font-bold text-gray-800 uppercase whitespace-nowrap">累計帳面</th>
                              </tr>
                            </thead>
                            <tbody>
                              {days.map(day => {
                                const dStr = format(day, 'yyyy-MM-dd');
                                const data = mergedData[dStr] as DailyData | undefined;
                                
                                if (data) {
                                  cumulative += (data.allianceReturns + data.transferAmount + data.priceChangeAmount - data.totalSales - data.salesAddition);
                                }
                                
                                return (
                                  <tr 
                                    key={dStr} 
                                    className={cn("border-b border-gray-50 active:bg-gray-50", isSameDay(day, new Date()) && "bg-gray-100/50")}
                                    onClick={() => {
                                      setCurrentDate(day);
                                      setActiveTab('daily');
                                    }}
                                  >
                                    <td className="px-4 py-3 text-xs font-bold text-gray-600 whitespace-nowrap">{format(day, 'd')}日</td>
                                    <td className="px-4 py-3 text-xs text-gray-500 tabular-nums">{data?.allianceReturns.toLocaleString() || '-'}</td>
                                    <td className="px-4 py-3 text-xs text-gray-500 tabular-nums">{data?.transferAmount.toLocaleString() || '-'}</td>
                                    <td className="px-4 py-3 text-xs text-gray-500 tabular-nums">{data?.priceChangeAmount.toLocaleString() || '-'}</td>
                                    <td className="px-4 py-3 text-xs text-gray-500 tabular-nums">{data?.totalSales.toLocaleString() || '-'}</td>
                                    <td className="px-4 py-3 text-xs text-gray-500 tabular-nums">{data?.salesAddition.toLocaleString() || '-'}</td>
                                    <td className="px-4 py-3 text-xs font-bold text-gray-800 tabular-nums">{data ? cumulative.toLocaleString() : '-'}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        );
                      }
                    })()}
                  </div>
                </div>
              </motion.div>
            )}

            {activeTab === 'history' && (
              <motion.div 
                key="history"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="space-y-4"
              >
                <h2 className="text-2xl font-bold px-2">歷史紀錄概覽</h2>
                <div className="space-y-3">
                  {/* List of months from MIN_DATE to current month */}
                  {(() => {
                    const months = [];
                    let d = startOfMonth(new Date());
                    while (d >= startOfMonth(MIN_DATE)) {
                      months.push(new Date(d));
                      d = subMonths(d, 1);
                    }
                    return months.map((d, i) => (
                      <div key={i} className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100 flex justify-between items-center">
                        <div>
                          <div className="text-lg font-bold">{format(d, 'yyyy年 MM月')}</div>
                          <div className="text-sm text-gray-400">點擊查看月報表</div>
                        </div>
                        <button 
                          onClick={() => {
                            setViewDate(d);
                            setActiveTab('monthly');
                          }}
                          className="p-3 bg-gray-50 rounded-xl text-airbnb"
                        >
                          <ChevronRight className="w-6 h-6" />
                        </button>
                      </div>
                    ));
                  })()}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </main>

        {/* Bottom Navigation */}
        <nav className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-100 px-6 py-3 flex justify-around items-center z-20 safe-area-bottom">
          <NavButton active={activeTab === 'daily'} onClick={() => setActiveTab('daily')} icon={<Calculator />} label="每日填報" />
          <NavButton active={activeTab === 'transfers'} onClick={() => setActiveTab('transfers')} icon={<ArrowLeftRight />} label="每日調撥" />
          <NavButton active={activeTab === 'monthly'} onClick={() => setActiveTab('monthly')} icon={<CalendarIcon />} label="月度概覽" />
          <NavButton active={activeTab === 'history'} onClick={() => setActiveTab('history')} icon={<History />} label="歷史數據" />
        </nav>
      </div>
    )}
  </ErrorBoundary>
);
}

function InputGroup({ label, value, onChange }: { label: string, value: number, onChange: (v: number) => void }) {
  return (
    <div className="space-y-1.5">
      <label className="text-[11px] font-bold text-gray-400 uppercase tracking-wider ml-1">{label}</label>
      <input 
        type="number" 
        inputMode="decimal"
        value={value || ''} 
        onChange={e => onChange(parseFloat(e.target.value) || 0)}
        placeholder="0"
        className="w-full bg-gray-50 border-2 border-transparent focus:border-airbnb focus:bg-white rounded-xl px-4 py-3 text-lg font-bold transition-all outline-none"
      />
    </div>
  );
}

function SignedInputGroup({ label, value, onChange }: { label: string, value: number, onChange: (v: number) => void }) {
  const isNegative = value < 0 || Object.is(value, -0);
  const absValue = Math.abs(value);

  return (
    <div className="space-y-1.5">
      <label className="text-[11px] font-bold text-gray-400 uppercase tracking-wider ml-1">{label}</label>
      <div className="flex gap-2">
        <button 
          type="button"
          onClick={() => {
            if (value === 0) {
              onChange(isNegative ? 0 : -0);
            } else {
              onChange(-value);
            }
          }}
          className={cn(
            "w-14 rounded-xl font-bold text-xl transition-all border-2 flex items-center justify-center shrink-0",
            isNegative 
              ? "bg-red-50 border-red-100 text-red-500 shadow-sm" 
              : "bg-green-50 border-green-100 text-green-500 shadow-sm"
          )}
        >
          {isNegative ? '-' : '+'}
        </button>
        <input 
          type="number" 
          inputMode="decimal"
          value={absValue === 0 ? '' : absValue} 
          onChange={e => {
            const val = Math.abs(parseFloat(e.target.value) || 0);
            onChange(isNegative ? (val === 0 ? -0 : -val) : val);
          }}
          placeholder="0"
          className="flex-1 bg-gray-50 border-2 border-transparent focus:border-airbnb focus:bg-white rounded-xl px-4 py-3 text-lg font-bold transition-all outline-none"
        />
      </div>
    </div>
  );
}

function ResultRow({ label, value, isCurrency = false, isPercent = false, highlight = false, color = "text-gray-900" }: { label: string, value: number, isCurrency?: boolean, isPercent?: boolean, highlight?: boolean, color?: string }) {
  return (
    <div className="flex justify-between items-center">
      <span className={cn("text-sm font-medium", highlight ? "text-gray-600" : "text-gray-400")}>{label}</span>
      <span className={cn("font-bold tabular-nums", highlight ? "text-xl" : "text-base", color)}>
        {isCurrency && "$"}
        {value.toLocaleString(undefined, { 
          minimumFractionDigits: (isCurrency || isPercent) ? 1 : 0, 
          maximumFractionDigits: (isCurrency || isPercent) ? 1 : 0 
        })}
        {isPercent && "%"}
      </span>
    </div>
  );
}

function NavButton({ active, onClick, icon, label }: { active: boolean, onClick: () => void, icon: React.ReactNode, label: string }) {
  return (
    <button 
      onClick={onClick}
      className={cn(
        "flex flex-col items-center gap-1 transition-all",
        active ? "text-airbnb scale-110" : "text-gray-300"
      )}
    >
      {React.cloneElement(icon as React.ReactElement, { className: "w-6 h-6" })}
      <span className="text-[10px] font-bold">{label}</span>
    </button>
  );
}
